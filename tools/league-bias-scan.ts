// CONTROL: run the same residual-bias + per-event scan on the LEAGUE training data (the model's
// own environment, neutral era/park), scoring each card-side with the deployed model. Lets us
// compare the tournament biases against the baseline: era-specific biases should be ~0 here;
// biases that PERSIST here are baseline MODEL bias (the Stuff-residual), not a tournament effect.
//
//   run: node tools/league-bias-scan.ts

import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, type Coeffs } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import type { EventForm } from "../src/model/curves.ts";

const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const TH = 500;
const repo = new Repository("data");
const state: any = (await repo.load<any>("state", "app")) ?? {};
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm: EventForm = trained.eventForm;
const base = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
const coeffs: Coeffs = { ...base, tournament_hr_adjust: false, park_avg_l: 1, park_avg_r: 1, park_hr_l: 1, park_hr_r: 1, park_gap: 1, era_bb: 1, era_k: 1, era_avg: 1, era_hr: 1, era_bip: 1, era_gap: 1, era_thr: 1, adv_hbp: 6, adv_sh: 3, adv_sf: 4, ssp_adv_hitting: 1, ssp_basic_hitting: 1, ssp_basic_pitching: 1 };
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const W = wobaWeightsFromCoeffs(coeffs), HBP = 6;
const rp = makeRawPolyModel(eventForm);

const years = availableYears(ROOT);
const { observations } = loadWindow(ROOT, years.slice(-2));
console.log(`\n=== LEAGUE baseline scan — ${ROOT}, window ${years.slice(-2).join("+")}, neutral env, deployed model ===`);

const asm = (e: any) => (W.bb * e.BB + W.hbp * HBP + W.b1 * e.oneB + W.xbh * e.XBH + W.hr * e.HR) / 600;
const hitEv = (o: TrainObs) => { const e = rp.predictHitting({ ...o.ratings.hit, speed: 0, steal: 0, run: 0 } as any, coeffs); const k = hittingComponents(e, 1, 1, o.bats || 1, "vR", coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.SO * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; };
const pitEv = (o: TrainObs) => { const e = rp.predictPitching(o.ratings.pitch as any, coeffs); const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.K * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; };
const actHitEv = (o: TrainObs) => { const g = (n: number) => n * 600 / o.hit.PA; return { BB: g(o.hit.BB), K: g(o.hit.K), HR: g(o.hit.HR), oneB: g(o.hit.b1), XBH: g(o.hit.b2 + o.hit.b3) }; };
const actPitEv = (o: TrainObs) => { const g = (n: number) => n * 600 / o.pitch.BF; return { BB: g(o.pitch.BB), K: g(o.pitch.K), HR: g(o.pitch.HR), oneB: g(o.pitch.b1), XBH: g(o.pitch.b2 + o.pitch.b3) }; };
const actHitW = (o: TrainObs) => asm({ BB: (o.hit.BB - o.hit.IBB) * 600 / o.hit.PA, HR: o.hit.HR * 600 / o.hit.PA, oneB: o.hit.b1 * 600 / o.hit.PA, XBH: (o.hit.b2 + o.hit.b3) * 600 / o.hit.PA });
const actPitW = (o: TrainObs) => asm({ BB: (o.pitch.BB - o.pitch.IBB) * 600 / o.pitch.BF, HR: o.pitch.HR * 600 / o.pitch.BF, oneB: o.pitch.b1 * 600 / o.pitch.BF, XBH: (o.pitch.b2 + o.pitch.b3) * 600 / o.pitch.BF });

const wmean = (x: number[], w: number[]) => x.reduce((s, v, i) => s + v * w[i]!, 0) / w.reduce((s, v) => s + v, 0);
const wp = (x: number[], y: number[], w: number[]) => { const mx = wmean(x, w), my = wmean(y, w); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { const dw = w[i]!, dx = x[i]! - mx, dy = y[i]! - my; a += dw * dx * dy; b += dw * dx * dx; c += dw * dy * dy; } return a / Math.sqrt(b * c); };
const residSlope = (pred: number[], act: number[], w: number[], rat: number[]) => { const mx = wmean(pred, w), my = wmean(act, w); let cxy = 0, cxx = 0; for (let i = 0; i < pred.length; i++) { cxy += w[i]! * (pred[i]! - mx) * (act[i]! - my); cxx += w[i]! * (pred[i]! - mx) ** 2; } const b = cxy / cxx, a0 = my - b * mx; const res = pred.map((p, i) => act[i]! - (a0 + b * p)); const mr = wmean(rat, w), sd = Math.sqrt(wmean(rat.map((v) => (v - mr) ** 2), w)) || 1; const z = rat.map((v) => (v - mr) / sd); const mres = wmean(res, w); let cz = 0, zz = 0; for (let i = 0; i < res.length; i++) { cz += w[i]! * z[i]! * (res[i]! - mres); zz += w[i]! * z[i]! ** 2; } return (cz / zz) * 1000; };

const H = observations.filter((o) => o.hit.PA >= TH), P = observations.filter((o) => o.pitch.BF >= TH);
const hw = H.map((o) => o.hit.PA), pw = P.map((o) => o.pitch.BF);
const hPredW = H.map((o) => asm(hitEv(o))), hActW = H.map(actHitW), pPredW = P.map((o) => asm(pitEv(o))), pActW = P.map(actPitW);
console.log(`\nwOBA correlation:  HITTERS n=${H.length} Pearson ${wp(hPredW, hActW, hw).toFixed(3)}   PITCHERS n=${P.length} Pearson ${wp(pPredW, pActW, pw).toFixed(3)}`);

const EV = ["BB", "K", "HR", "oneB", "XBH"], LBL: any = { BB: "BB", K: "K", HR: "HR", oneB: "1B", XBH: "XBH" };
console.log(`\nper-EVENT accuracy (Pearson, ≥${TH}):`);
console.log(`  HITTERS   ${EV.map((e) => `${LBL[e]} ${wp(H.map((o) => (hitEv(o) as any)[e]), H.map((o) => (actHitEv(o) as any)[e]), hw).toFixed(2)}`).join("  ")}`);
console.log(`  PITCHERS  ${EV.map((e) => `${LBL[e]} ${wp(P.map((o) => (pitEv(o) as any)[e]), P.map((o) => (actPitEv(o) as any)[e]), pw).toFixed(2)}`).join("  ")}`);

console.log(`\nfull bias scan (residual wOBA pts/SD, want ≈0):`);
const hr = H.map((o) => o.ratings.hit);
console.log(`  HITTERS   EYE→BB ${residSlope(hPredW, hActW, hw, hr.map((r) => r.eye)).toFixed(2)}  POW→HR ${residSlope(hPredW, hActW, hw, hr.map((r) => r.pow)).toFixed(2)}  AvoidK→K ${residSlope(hPredW, hActW, hw, hr.map((r) => r.kRat)).toFixed(2)}  BABIP→H ${residSlope(hPredW, hActW, hw, hr.map((r) => r.babip)).toFixed(2)}  GAP→GAP ${residSlope(hPredW, hActW, hw, hr.map((r) => r.gap)).toFixed(2)}`);
const pr = P.map((o) => o.ratings.pitch);
console.log(`  PITCHERS  CON→BB ${residSlope(pPredW, pActW, pw, pr.map((r) => r.con)).toFixed(2)}  HRA→HR ${residSlope(pPredW, pActW, pw, pr.map((r) => r.hrr)).toFixed(2)}  STU→K ${residSlope(pPredW, pActW, pw, pr.map((r) => r.stu)).toFixed(2)}  pBABIP→H ${residSlope(pPredW, pActW, pw, pr.map((r) => r.pbabip)).toFixed(2)}`);
process.exit(0);
