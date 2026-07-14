// FADE MICRO-STUDY (Fable: the fade spec is RESCINDED — probably wrong). The own-gap fade TAPERS the lift to
// ~0 as a rating approaches the trained ceiling C, so near-ceiling cards are lifted LESS than mid cards. Fable's
// mechanistic critique: the opponent benefit does NOT shrink with a card's OWN rating (every card faces the same
// weak pool), and through the log channels the taper imposes a ~b·ln(k) RELATIVE penalty on near-ceiling cards
// the anchor cannot absorb. TEST: for NEAR-CEILING cards (the ones the fade acts on), which fits actuals better —
// fade-on (production) or fade-off pure ×k? Method: global affine-align each variant's preds to actuals (removes
// the harmless level/scale the anchor handles), then compare the RESIDUAL on the near-ceiling subset. A larger
// near-ceiling residual under fade-on ⇒ the taper mis-serves elite cards ⇒ retire the fade.
//   Variants: fade-on = production envelope; pureK = ×k, no taper, no clamp (buildPoolTransform env=undefined).
//   run: node tools/fade-microstudy.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250, NEAR = 0.9;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const env = trained.ratingEnvelope;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);

const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
// affine-align pred→real over ALL cards (removes level+scale the anchor absorbs), return residual real−(α+β·pred).
function residuals(cv: CardValues) {
  const mp = wmean(cv.pred, cv.w), mr = wmean(cv.real, cv.w); let cov = 0, vp = 0;
  for (let i = 0; i < cv.pred.length; i++) { const dp = cv.pred[i]! - mp; cov += cv.w[i]! * dp * (cv.real[i]! - mr); vp += cv.w[i]! * dp * dp; }
  const beta = vp > 1e-15 ? cov / vp : 0, alpha = mr - beta * mp;
  return cv.pred.map((p, i) => cv.real[i]! - (alpha + beta * p));
}
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(4) : "  n/a ");

console.log(`FADE MICRO-STUDY — near-ceiling (≥${NEAR}·C in a value-driving rating) pred-vs-actual, affine-aligned residual.`);
console.log(`fade-on = production taper; pureK = ×k no taper/clamp. NEGATIVE residual = model OVER-predicts; POSITIVE = UNDER.`);
console.log(`Prediction (Fable): fade-on UNDER-serves near-ceiling elite (taper under-lifts) ⇒ larger |residual| than pureK.\n`);
console.log(`dataset·role    near-ceil N   nearBias fade-on / pureK    nearRMSE fade-on / pureK   (all-card bias for ref)`);

for (const [name, dir, TID] of [
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Open", "Tournament Data/Quicks - Open", "default-neutral"],
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
  const fadeOn = { poolTransform: buildPoolTransform(refField, poolField, env) };
  const pureK = { poolTransform: buildPoolTransform(refField, poolField, undefined) };
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  for (const role of ["pit", "hit"] as const) {
    const drivers = role === "pit" ? ["stu", "con", "hrr"] : ["pow", "eye"];
    const cel = env[role];
    const qual = obs.filter((o) => (role === "pit" ? o.bf : o.pa) >= TH);
    const nearMask = qual.map((o) => drivers.some((d) => { const r = Math.max((o.ratings[role].vR as any)[d] ?? 0, (o.ratings[role].vL as any)[d] ?? 0); return cel[d] ? r >= NEAR * cel[d] : false; }));
    const nN = nearMask.filter(Boolean).length;
    if (qual.length < 8 || nN < 4) { console.log(`${(name + "·" + role).padEnd(15)} near N=${nN} thin`); continue; }
    const cvOn = (tournamentCardValues(obs, { coeffs, eventForm: ef, ...fadeOn }, exposure, { minPA: TH, minBF: TH }) as any)[role] as CardValues;
    const cvK = (tournamentCardValues(obs, { coeffs, eventForm: ef, ...pureK }, exposure, { minPA: TH, minBF: TH }) as any)[role] as CardValues;
    const rOn = residuals(cvOn), rK = residuals(cvK);
    const near = (arr: number[]) => arr.filter((_, i) => nearMask[i]);
    const wN = near(cvOn.w);
    const bias = (r: number[]) => wmean(near(r), wN);
    const rmse = (r: number[]) => Math.sqrt(wmean(near(r).map((x) => x * x), wN));
    const allBiasOn = wmean(rOn, cvOn.w);
    console.log(`${(name + "·" + role).padEnd(15)} N=${String(nN).padStart(3)}     ${f(bias(rOn))} / ${f(bias(rK))}      ${f(rmse(rOn))} / ${f(rmse(rK))}    (all ${f(allBiasOn)})`);
  }
}
console.log(`\nRead: near-ceiling bias should be ~0 if the transform serves elite right. If fade-on shows a systematic POSITIVE`);
console.log(`near-ceiling residual (under-predict) that pureK SHRINKS, the taper is under-lifting elite → retire the fade.`);
console.log(`If fade-on ≈ pureK everywhere, the fade is INERT at these pools (Fable: zero coverage where it acts) → retire as dead weight.`);
process.exit(0);
