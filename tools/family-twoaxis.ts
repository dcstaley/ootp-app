// PRE-HYP-1 (Derek): the curve FAMILY was picked on spread-blind metrics (Pearson is affine-invariant).
// Re-evaluate the coded bake-off families under AXIS 2 (noise-deconvolved VALUE spread-ratio) alongside
// in-frame ordering — no new fitting code, just re-run the fitters + score. Decision: adopt any family
// that raises OUT-OF-FRAME pitcher value spread WITHOUT losing in-frame calibration/ordering; then size
// Hyp-1's s_pit to the REMAINING deficit. Deployed K curve is LOG (flattens at high Stuff) — raw-poly
// degrees are the candidates that might preserve the top-Stuff K spread.
//   run: node tools/family-twoaxis.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK, computeDerived } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, RAWPOLY_PIT, STUFFAUG_PIT, RAWQUAD_HIT, RAWQUAD_PIT, RAWCUBIC_HIT, RAWCUBIC_PIT, LOG_HIT, LOG_PIT, QPOWLIN_HIT, QPOWLIN_PIT } from "../src/training/forms.ts";
import type { EventForm } from "../src/model/curves.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const sPitFn = (g: number) => 1 + 1.03 * (1 - Math.exp(-g / 14.5));
const sHitFn = (g: number) => 1 + 0.76 * (1 - Math.exp(-g / 17.5));
const FIELD_N = 50, TH = 100;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";

const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const lgObs = loadWindow(TRAIN, win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const lgHit = lgObs.filter((o) => HITTER.qualifies(o, minPA)), lgPit = lgObs.filter((o) => PITCHER.qualifies(o, minPA));

// Neutral coeffs (era-2010, park-1) for in-frame league scoring.
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const nCoeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(nCoeffs, trained.wobaWeights);
const nDeriv = computeDerived(nCoeffs, true);
const nw = wobaWeightsFromCoeffs(nCoeffs);

const wvar = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + w[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + w[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + w[i]! * v, 0) / sw; };
const seW = (rate: { uBB: number; HmHR: number; HR: number; XBH: number }, denom: number) => { const t: [number, number][] = [[nw.bb, rate.uBB / 600], [nw.b1, (rate.HmHR - rate.XBH) / 600], [nw.xbh, rate.XBH / 600], [nw.hr, rate.HR / 600]]; const E = t.reduce((a, [w, p]) => a + w * p, 0), E2 = t.reduce((a, [w, p]) => a + w * w * p, 0); return denom > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / denom) : 0; };
const ratio = (cv: CardValues, se: number[]) => { const sPred = Math.sqrt(wvar(cv.pred, cv.w)); const sTrue = Math.sqrt(Math.max(wvar(cv.real, cv.w) - wmean(se.map((s) => s * s), cv.w), 1e-9)); return sPred / sTrue; };
const pearson = (cv: CardValues) => { const mp = wmean(cv.pred, cv.w), mr = wmean(cv.real, cv.w); let c = 0, vp = 0, vr = 0; for (let i = 0; i < cv.pred.length; i++) { const dp = cv.pred[i]! - mp, dr = cv.real[i]! - mr; c += cv.w[i]! * dp * dr; vp += cv.w[i]! * dp * dp; vr += cv.w[i]! * dr * dr; } return c / Math.sqrt(vp * vr); };

// In-frame league value arrays for a fitted eventForm (own ratings, neutral coeffs).
function leagueCV(ef: EventForm): { hit: CardValues; pit: CardValues; seHit: number[]; sePit: number[] } {
  const m = makeRawPolyModel(ef);
  const asmH = (o: TrainObs) => { const e = m.predictHitting(o.ratings.hit, nCoeffs); const k = hittingComponents(e, 1, 1, 1, "vR", nCoeffs, nDeriv, ef); return (nw.bb * k.BB_fin + nw.hbp * nCoeffs.adv_hbp + nw.b1 * k.oneB_fin + nw.xbh * k.GAP_fin + nw.hr * k.HR_fin) / 600; };
  const asmP = (o: TrainObs) => { const e = m.predictPitching(o.ratings.pitch, nCoeffs); const k = pitchingComponents(e, 1, 1, "vR", nCoeffs, nDeriv, ef); return (nw.bb * k.BB_fin + nw.hbp * nCoeffs.adv_hbp + nw.b1 * k.oneB_fin + nw.xbh * k.XBH_fin + nw.hr * k.HR_fin) / 600; };
  const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
  const realH = (o: TrainObs) => { const r = { uBB: per600(o.hit.BB - o.hit.IBB, o.hit.PA), HmHR: per600(o.hit.H - o.hit.HR, o.hit.PA), HR: per600(o.hit.HR, o.hit.PA), XBH: per600(o.hit.b2 + o.hit.b3, o.hit.PA) }; return { woba: (nw.bb * r.uBB + nw.hbp * nCoeffs.adv_hbp + nw.b1 * (r.HmHR - r.XBH) + nw.xbh * r.XBH + nw.hr * r.HR) / 600, r, d: o.hit.PA }; };
  const realP = (o: TrainObs) => { const r = { uBB: per600(o.pitch.BB - o.pitch.IBB, o.pitch.BF), HmHR: per600(o.pitch.b1 + o.pitch.b2 + o.pitch.b3, o.pitch.BF), HR: per600(o.pitch.HR, o.pitch.BF), XBH: per600(o.pitch.b2 + o.pitch.b3, o.pitch.BF) }; return { woba: (nw.bb * r.uBB + nw.hbp * nCoeffs.adv_hbp + nw.b1 * (r.HmHR - r.XBH) + nw.xbh * r.XBH + nw.hr * r.HR) / 600, r, d: o.pitch.BF }; };
  const hR = lgHit.map(realH), pR = lgPit.map(realP);
  return {
    hit: { pred: lgHit.map(asmH), real: hR.map((x) => x.woba), w: hR.map((x) => x.d) },
    pit: { pred: lgPit.map(asmP), real: pR.map((x) => x.woba), w: pR.map((x) => x.d) },
    seHit: hR.map((x) => seW(x.r, x.d)), sePit: pR.map((x) => seW(x.r, x.d)),
  };
}

// Out-of-frame tournament pit/hit value spread (own-gap), per fitted family.
const TDS = [["EG", "Tournament Data/Early Gold", "early-gold"], ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"]] as const;
const tset = [] as { name: string; obs: TournamentObs[]; exposure: any; coeffs: any; own: any; seHit: number[]; sePit: number[] }[];
for (const [name, dir, TID] of TDS) {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, makeRawPolyModel(trained.eventForm), FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, makeRawPolyModel(trained.eventForm), FIELD_N, true);
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const ww = wobaWeightsFromCoeffs(coeffs);
  const seR = (a: any, d: number) => { const t2: [number, number][] = [[ww.bb, a.uBB / 600], [ww.b1, (a.HmHR - (a.XBH ?? 0)) / 600], [ww.xbh, (a.XBH ?? 0) / 600], [ww.hr, a.HR / 600]]; const E = t2.reduce((s, [w, p]) => s + w * p, 0), E2 = t2.reduce((s, [w, p]) => s + w * w * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };
  tset.push({ name, obs, exposure: tournamentExposure(obs), coeffs, own, seHit: obs.filter((o) => o.pa >= TH).map((o) => seR(o.actual.hit, o.pa)), sePit: obs.filter((o) => o.bf >= TH).map((o) => seR(o.actual.pit, o.bf)) });
}

// Hitter FIXED at the deployed RAWPOLY_HIT (in-frame hit spread already ~0.97); vary only the PITCHER
// curve so the pit-spread effect is isolated. Hybrids = StuffAug (keep BB/HR Stuff-aux, which works)
// with the K curve un-flattened from LOG to raw-poly — a form config, not new fitting code.
const SA_RAWQ = { ...STUFFAUG_PIT, name: "stuffaug+rawquadK", k: { kind: "rawpoly", degree: 2 } } as any;
const SA_RAWC = { ...STUFFAUG_PIT, name: "stuffaug+rawcubicK", k: { kind: "rawpoly", degree: 3 } } as any;
const FAMILIES: [string, any, any][] = [
  ["deployed stuffaug(K=log)", RAWPOLY_HIT, STUFFAUG_PIT],
  ["stuffaug+rawquadK", RAWPOLY_HIT, SA_RAWQ],
  ["stuffaug+rawcubicK", RAWPOLY_HIT, SA_RAWC],
  ["rawpoly_pit(K=log,noSA)", RAWPOLY_HIT, RAWPOLY_PIT],
  ["rawquad_pit(fullraw)", RAWPOLY_HIT, RAWQUAD_PIT],
  ["rawcubic_pit(fullraw)", RAWPOLY_HIT, RAWCUBIC_PIT],
];
const f3 = (n: number) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(3) : "  n/a");
console.log(`Family two-axis sweep — model window ${win.join("+") || "all"}, deconv value spread-ratio (→1.0). Deployed = rawpoly/stuffaug.\n`);
console.log(`family                       IN-FRAME(league)              OUT-OF-FRAME own-gap`);
console.log(`                             hitSpread pitSpread pitPears  EG-pit BR-pit  EG-hit BR-hit`);
for (const [name, hf, pf] of FAMILIES) {
  const ef: EventForm = { hit: fitHitForm(hf, lgObs), pit: fitPitForm(pf, lgObs) };
  const lc = leagueCV(ef);
  const inHit = ratio(lc.hit, lc.seHit), inPit = ratio(lc.pit, lc.sePit), inPitP = pearson(lc.pit);
  const out: Record<string, number> = {};
  for (const d of tset) { const cv = tournamentCardValues(d.obs, { coeffs: d.coeffs, eventForm: ef, ...d.own }, d.exposure, { minPA: TH, minBF: TH }); out[`${d.name}-pit`] = ratio(cv.pit, d.sePit); out[`${d.name}-hit`] = ratio(cv.hit, d.seHit); }
  console.log(`${name.padEnd(28)} ${f3(inHit)}   ${f3(inPit)}   ${f3(inPitP)}   ${f3(out["EG-pit"]!)} ${f3(out["Bronze-t-pit"]!)}  ${f3(out["EG-hit"]!)} ${f3(out["Bronze-t-hit"]!)}`);
}
console.log(`\nDecision: adopt a family that raises OUT-OF-FRAME pit spread vs deployed WITHOUT dropping in-frame pit spread/Pearson; size Hyp-1 s_pit to the residual.`);
process.exit(0);
