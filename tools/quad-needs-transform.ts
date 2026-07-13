// Derek's hypothesis: with a raw-QUAD form, the transform is REQUIRED to capture the quad effect in
// low-power pools — the curvature lives at high ratings, weak pools sit in the flat low region, so
// WITHOUT a transform to lift them into the steep region the quad's spread never activates.
// DIRECT TEST (no deconvolution): under the rawquad+aux form, PREDICTED pitcher value spread (weighted
// SD, no noise) per pool in BASE vs frame-v2 vs own-gap. If base ≪ transform in weak pools (and the gap
// GROWS as the pool weakens), the quad effect is lost without the transform → Derek is right.
//   run: node tools/quad-needs-transform.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type CardValues } from "../src/training/tournament-eval.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT } from "../src/training/forms.ts";
import type { EventForm } from "../src/model/curves.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const;
const FIELD_N = 50, TH = 100, S_K = 1.75, G0_K = 17;
const kRamp = (g: number) => 1 + (S_K - 1) * Math.min(Math.max(g / G0_K, 0), 1);
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const lgObs = loadWindow("League Files", win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const rawqForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm({ name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true } as any, lgObs) };
const deployedForm = trained.eventForm as EventForm;

const wsd = (cv: CardValues) => { const sw = cv.w.reduce((a: number, b: number) => a + b, 0); const m = cv.pred.reduce((a, v, i) => a + cv.w[i]! * v, 0) / sw; return Math.sqrt(cv.pred.reduce((a, v, i) => a + cv.w[i]! * (v - m) ** 2, 0) / sw); };
const f4 = (n: number) => n.toFixed(4);

console.log(`QUAD-NEEDS-TRANSFORM — predicted PIT value SD (no noise) per pool, rawquad+aux form.`);
console.log(`If base ≪ transform and the gap GROWS as the pool weakens (μStu falls) → quad effect lost without lift.\n`);
console.log(`pool         μStu(pool)  gap   | rawquad: base   frameV2  own-gap | deployed(log): base  frameV2`);
for (const [name, dir, TID] of [
  ["Open", "Tournament Data/Quicks - Open", "default-neutral"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["EG", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, makeRawPolyModel(rawqForm), FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, makeRawPolyModel(rawqForm), FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, makeRawPolyModel(rawqForm), fs, FIELD_N);
  const kSpread = { sHit: kRamp(fs.hit.vR.kRat ?? 0), sPit: kRamp(fs.pit.vR.stu ?? 0), meanHit: kb.hit, meanPit: kb.pit };
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const fv2 = { frameShift: fs, kSpread };
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const muStu = poolField.pit.vR.stu!.mu, gap = fs.pit.vR.stu ?? 0;
  const sd = (ef: EventForm, extra: any) => wsd(tournamentCardValues(obs, { coeffs, eventForm: ef, ...extra }, exposure, { minPA: TH, minBF: TH }).pit);
  console.log(`${name.padEnd(11)} ${muStu.toFixed(0).padStart(6)}    ${gap.toFixed(0).padStart(4)}  |  ${f4(sd(rawqForm, {}))}  ${f4(sd(rawqForm, fv2))}  ${f4(sd(rawqForm, own))} | ${f4(sd(deployedForm, {}))}  ${f4(sd(deployedForm, fv2))}`);
}
console.log(`\nRead: within rawquad, does base-frame predicted SD fall (vs frameV2/own-gap) as μStu drops? If the`);
console.log(`transform's SD lift GROWS as pools weaken, the quad curvature needs the lift → transforms required (Derek).`);
process.exit(0);
