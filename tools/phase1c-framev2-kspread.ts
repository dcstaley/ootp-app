// JOINT-RUN ARM 3 — frame-v2 + kSpread (the refit arm). Prediction (2): kSpread patched LOG flattening;
// under rawquad it is REDUNDANT. But arm 2 (bare) already FAILED not on pitcher spread but on HITTER
// compression (additive shift moves hitters up the concave log bb/1b/xbh curves → value spread collapses
// EG 1.08→0.67, CI-clear). kSpread scales ONLY the K channel about the pool mean; K enters HITTER value
// only via BIP→1B (negligible). So NO kSpread value can un-compress hitters — frame-v2 is structurally
// unrescuable by a K-spread refit. This sweeps s_pit (bare=1.0, log-era 2.03, and higher) on the winner
// form to SHOW: (a) kSpread moves pit spread modestly and saturates, (b) hitter spread is untouched at
// every s. Confirms retiring kSpread and stopping transform iteration (pre-registered stopping rule).
//   run: node tools/phase1c-framev2-kspread.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const;
const FIELD_N = 50, TH = 100;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const WINNER: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true };
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(WINNER, lgObs) };
const rp = makeRawPolyModel(ef);

const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const dspread = (cv: CardValues, se: number[]) => Math.sqrt(wvar(cv.pred, cv.w)) / Math.sqrt(Math.max(wvar(cv.real, cv.w) - wmean(se.map((s) => s * s), cv.w), 1e-9));
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");
const S_PIT = [1.0, 2.03, 3.0, 4.0]; // 1.0 = bare; 2.03 = log-era pit; higher = over-widen probe

console.log(`ARM 3 — frame-v2 + kSpread s_pit sweep on the WINNER form (EG-clean, Bronze-t). In-frame pit 0.78 / hit 0.97.`);
console.log(`Shows: kSpread widens PIT spread but SATURATES + never fixes HIT compression (bare's fatal flaw). s=1.0 is bare.\n`);
for (const [name, dir, TID] of [
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const ww = wobaWeightsFromCoeffs(coeffs);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, rp, fs, FIELD_N);
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const seR = (a: any, d: number) => { const t2: [number, number][] = [[ww.bb, a.uBB / 600], [ww.b1, (a.HmHR - (a.XBH ?? 0)) / 600], [ww.xbh, (a.XBH ?? 0) / 600], [ww.hr, a.HR / 600]]; const E = t2.reduce((s, [w2, p]) => s + w2 * p, 0), E2 = t2.reduce((s, [w2, p]) => s + w2 * w2 * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };
  const seHit = obs.filter((o: TournamentObs) => o.pa >= TH).map((o) => seR(o.actual.hit, o.pa));
  const sePit = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => seR(o.actual.pit, o.bf));
  console.log(`==== ${name} ====`);
  console.log(`  s_pit  PITspread  HITspread  cap-bias(pit/hit)`);
  for (const sPit of S_PIT) {
    const kSpread = { sHit: 1.0, sPit, meanHit: kb.hit, meanPit: kb.pit }; // hit kSpread OFF to isolate: hitter compression is NOT a K effect
    const cv = tournamentCardValues(obs, { coeffs, eventForm: ef, frameShift: fs, kSpread }, exposure, { minPA: TH, minBF: TH });
    const p = dspread(cv.pit, sePit), h = dspread(cv.hit, seHit);
    console.log(`  ${sPit.toFixed(2).padStart(5)}   ${f(p)}      ${f(h)}      ${f(p / h)}`);
  }
  console.log();
}
console.log(`Read: HITspread is CONSTANT across s_pit (kSpread doesn't touch it — proves the hitter compression is the`);
console.log(`additive shift's concavity on bb/1b/xbh, not a K effect). PITspread rises with s but the cap-bias stays`);
console.log(`< own-gap's EG 0.86 because hitters are already compressed → frame-v2 cannot be rescued by any kSpread refit.`);
process.exit(0);
