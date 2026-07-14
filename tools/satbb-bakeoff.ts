// SATURATING-BB BAKE-OFF (Fable item 1). Candidate SATBB_PIT (BB = b0+b1·e^(−con/τ), grid-τ; k/hr/h quad; Stuff
// aux retained) vs the shipped pareto (BB = log). Two axes on league + the HEADLINE metric: the high-CON
// over-valuation slice on Bronze-t/EG (+7.0 / +3.3 mwOBA) MUST collapse — that is the closing fix for the
// Donohue/Stuff-residual ticket. Standard adoption bar (material, CI-clear, OOT-confirmed; gate pass).
//   run: node tools/satbb-bakeoff.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, computeDerived } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { applyAffine } from "../src/model/pool-transform.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs } from "../src/training/tournament-eval.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { inSample, crossValidate, outOfTime } from "../src/training/evaluate.ts";
import { fitHitForm, fitPitForm, pitFormModel, gatePit, RAWPOLY_HIT, SATBB_PIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { rate } from "../src/model/curves.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { EventForm, FittedHit } from "../src/model/curves.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250, MINN = 1000;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const years = availableYears("League Files");
const oldObs = [2032, 2033].every((y) => years.includes(y)) ? loadWindow("League Files", [2032, 2033]).observations : [];
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "pareto(logBB)", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const hitFit = fitHitForm(RAWPOLY_HIT, lgObs) as FittedHit;
const FORMS: [string, PitForm][] = [["pareto(logBB)", PARETO], ["satbb", { ...SATBB_PIT, name: "satbb" }]];

const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
const wmean = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); return sw ? x.reduce((a, v, i) => a + w[i]! * v, 0) / sw : 0; };
const wvar = (x: number[], wt: number[]) => { const m = wmean(x, wt); return wmean(x.map((v) => (v - m) ** 2), wt); };
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? "+" : "") + n.toFixed(3) : " n/a");
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : " n/a");

// ── League CV/OOT + gate + fitted BB curve shape ──
console.log(`SATURATING-BB BAKE-OFF — candidate satbb vs shipped pareto(logBB). window ${win.join("+")}.\n`);
console.log(`LEAGUE (pit): in-sample / CV5 / OOT-down(41-42→32-33) — r / ρ / regret ; + gate + fitted BB(con) shape`);
for (const [name, pf] of FORMS) {
  const mdl = pitFormModel(pf);
  const is = inSample(lgObs, mdl, PITCHER, { minN: MINN }), cv = crossValidate(lgObs, mdl, PITCHER, { minN: MINN, k: 5 });
  const oot = oldObs.length ? outOfTime(lgObs, oldObs, mdl, PITCHER, { minN: MINN }) : null;
  const fit = fitPitForm(pf, lgObs);
  const g = gatePit(fit, lgObs.filter((o) => PITCHER.qualifies(o, MINN)));
  const bbAt = (con: number) => rate(fit.bb, con) + (fit.bb.aux ? fit.bb.aux.beta * (fit.bb.aux.sd > 1e-9 ? (Math.log(Math.max(120, 1)) - fit.bb.aux.mu) / fit.bb.aux.sd : 0) : 0);
  console.log(`  ${name.padEnd(14)} r ${f2(is.pearson)}/${f2(cv.pearson)}/${oot ? f2(oot.pearson) : "—"}  ρ ${f2(is.spearman)}/${f2(cv.spearman)}/${oot ? f2(oot.spearman) : "—"}  regret ${f2(cv.valueRegret)}/${oot ? f2(oot.valueRegret) : "—"}  gate ${g.status}`);
  console.log(`  ${"".padEnd(14)} BB/600 @ con 40/80/120/160/200 (stu=120): ${[40, 80, 120, 160, 200].map((c) => bbAt(c).toFixed(1)).join(" / ")}${fit.bb.curve.kind === "satexp" ? `  τ=${(fit.bb.curve as any).tau}` : ""}`);
}

// ── In-frame deconvolved pit value spread + HEADLINE high-CON over-valuation slice ──
console.log(`\nHEADLINE — high-CON over-valuation slice (affine-aligned VALUE over-rate, mwOBA; +7.0 Bronze-t / +3.3 EG must collapse):`);
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
for (const [name, pf] of FORMS) {
  const ef: EventForm = { hit: hitFit, pit: fitPitForm(pf, lgObs) };
  const rp = makeRawPolyModel(ef);
  // in-frame deconvolved spread
  const nc = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps); if (trained.wobaWeights) applyWobaWeights(nc, trained.wobaWeights);
  const nd = computeDerived(nc, true), nw = wobaWeightsFromCoeffs(nc);
  const lgPit = lgObs.filter((o) => PITCHER.qualifies(o, MINN));
  const pr: number[] = [], re: number[] = [], wt: number[] = [], se: number[] = [];
  for (const o of lgPit) { const e = rp.predictPitching(o.ratings.pitch, nc); const k = pitchingComponents(e, 1, 1, "vR", nc, nd, ef);
    pr.push((nw.bb * k.BB_fin + nw.hbp * nc.adv_hbp + nw.b1 * k.oneB_fin + nw.xbh * k.XBH_fin + nw.hr * k.HR_fin) / 600);
    const uBB = per600(o.pitch.BB - o.pitch.IBB, o.pitch.BF), HmHR = per600(o.pitch.b1 + o.pitch.b2 + o.pitch.b3, o.pitch.BF), HR = per600(o.pitch.HR, o.pitch.BF), XBH = per600(o.pitch.b2 + o.pitch.b3, o.pitch.BF);
    re.push((nw.bb * uBB + nw.hbp * nc.adv_hbp + nw.b1 * (HmHR - XBH) + nw.xbh * XBH + nw.hr * HR) / 600); wt.push(o.pitch.BF);
    const t2: [number, number][] = [[nw.bb, uBB / 600], [nw.b1, (HmHR - XBH) / 600], [nw.xbh, XBH / 600], [nw.hr, HR / 600]]; const E = t2.reduce((s, [w2, p]) => s + w2 * p, 0), E2 = t2.reduce((s, [w2, p]) => s + w2 * w2 * p, 0); se.push(o.pitch.BF > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / o.pitch.BF) : 0);
  }
  const inframe = Math.sqrt(wvar(pr, wt)) / Math.sqrt(Math.max(wvar(re, wt) - wmean(se.map((s) => s * s), wt), 1e-9));
  const cells: string[] = [];
  for (const [dn, dir, TID] of [["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"], ["EG", "Tournament Data/Early Gold", "early-gold"], ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"]] as const) {
    if (!existsSync(dir)) continue;
    const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
    const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps); if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
    const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
    const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
    const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
    const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
    const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
    const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
    const exposure = tournamentExposure(obs);
    const cv = tournamentCardValues(obs, { coeffs, eventForm: ef, ...own }, exposure, { minPA: TH, minBF: TH }).pit;
    const qual = obs.filter((o: TournamentObs) => o.bf >= TH);
    const mp = wmean(cv.pred, cv.w), mr = wmean(cv.real, cv.w); let cova = 0, vp = 0; for (let i = 0; i < cv.pred.length; i++) { const dp = cv.pred[i]! - mp; cova += cv.w[i]! * dp * (cv.real[i]! - mr); vp += cv.w[i]! * dp * dp; } const beta = vp > 1e-15 ? cova / vp : 0, alpha = mr - beta * mp;
    const rows = qual.map((o, i) => ({ con: o.ratings.pit.vR.con, over: cv.real[i]! - (alpha + beta * cv.pred[i]!), w: cv.w[i]! }));
    const hi = [...rows].sort((a, b) => a.con - b.con).slice(Math.floor(rows.length * 2 / 3));
    cells.push(`${dn} ${(wmean(hi.map((r) => r.over), hi.map((r) => r.w)) * 1000).toFixed(2)}`);
  }
  console.log(`  ${name.padEnd(14)} in-frame spread ${f2(inframe)}  | HIGH-con over-rate: ${cells.join("  ")}`);
}
console.log(`\nADOPT iff: high-CON over-rate collapses toward 0 on Bronze-t/EG, in-frame spread ~holds (≥ pareto's ~0.74 not required —`);
console.log(`BB isn't the spread channel), league CV/OOT r/ρ/regret ≥ pareto within noise, gate pass. Else keep pareto + fade iron-gated.`);
process.exit(0);
