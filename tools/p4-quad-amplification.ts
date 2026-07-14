// P4 — QUAD-AMPLIFICATION BOUND. Correction 5 (memory 28b): own-gap MULTIPLICATIVE is spread-NEUTRAL on the
// log channels (b·ln(k·r) = level shift) but on the QUAD channels it amplifies spread ~k² (a·(k·r)² term). The
// open question: does that over-EXPAND at high gap? The hint = EG pit spread 0.93 > in-frame 0.78. TEST: the
// model's own PREDICTED pit value SD (no deconvolution needed — model-vs-model) under own-gap (mult) vs
// frame-v2 (additive) across the now-powered gap ladder (Open≈0 / Gold+Bronze-q≈17-22 / EG≈27). If own-gap SD
// grows SUPER-linearly in the gap while additive stays ~flat, multiplicative amplification is real; the ratio
// own/additive rising with gap bounds it. Base (no transform) SD anchors the in-frame prediction spread.
//   run: node tools/p4-quad-amplification.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type CardValues } from "../src/training/tournament-eval.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250;
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
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);

const wsd = (cv: CardValues) => { const sw = cv.w.reduce((a: number, b: number) => a + b, 0); const m = cv.pred.reduce((a, v, i) => a + cv.w[i]! * v, 0) / sw; return Math.sqrt(cv.pred.reduce((a, v, i) => a + cv.w[i]! * (v - m) ** 2, 0) / sw); };
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : " n/a ");

console.log(`P4 — quad-amplification bound. PREDICTED pit value SD (shipped pareto) under base / own-gap(mult) / frame-v2(add),`);
console.log(`across the gap ladder. If own-gap SD grows SUPER-linearly in the gap (own/base ratio rising faster than add/base),`);
console.log(`multiplicative over-amplifies the quad channels. In-frame pred SD is the base-frame value.\n`);
console.log(`pool        gap  | pred SD:  base      own-gap    frameV2  | ratio own/base  add/base  own/add`);
const ladder = [
  ["Open", "Tournament Data/Quicks - Open", "default-neutral"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const;
const byGap: { gap: number; own: number; add: number; base: number }[] = [];
for (const [name, dir, TID] of ladder) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const gap = fs.pit.vR.stu ?? 0;
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const sd = (extra: any) => wsd(tournamentCardValues(obs, { coeffs, eventForm: ef, ...extra }, exposure, { minPA: TH, minBF: TH }).pit);
  const base = sd({}), o = sd(own), a = sd({ frameShift: fs });
  byGap.push({ gap, own: o, add: a, base });
  console.log(`${name.padEnd(11)} ${gap.toFixed(0).padStart(3)}  |  ${f(base)}  ${f(o)}  ${f(a)}  |  ${f(o / base)}       ${f(a / base)}     ${f(o / a)}`);
}
console.log(`\nRead: own/base RISING with gap (esp. EG gap≈27) faster than add/base ⇒ multiplicative amplifies the quad`);
console.log(`channels super-linearly. own/add > 1 and growing = the over-expansion bound. If own/add ≈ flat ~1, the`);
console.log(`EG 0.93>0.78 hint is NOT multiplicative amplification (it's dataset/noise) and mult-vs-add ties on quad too.`);
process.exit(0);
