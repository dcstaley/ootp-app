// Throwaway validation for the unit-elasticity BIP fix (perBip) — and, phase 2, the uBB
// fit targets. Fits the OLD form (fitted log-BIP coefficient, hBip: LOG) vs the NEW form
// (hBip default "unit": H = perBIP(rating) × BIP) on the league window (last 2 years of
// "League Files"), then reports, for BOTH tournaments (Early Gold = dead-ball era-1920,
// Return of the Bronze), the per-event level bias mean(pred − act) per 600 at ≥500 PA/BF,
// PA/BF-weighted, NO pool transform. Also reports league in-sample fit quality old vs new.
//
//   run: node tools/tournament-bipfix-validate.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import {
  fitHitForm, fitPitForm, predictHitForm, predictPitForm,
  RAWPOLY_HIT, STUFFAUG_PIT, type HitForm, type PitForm,
} from "../src/training/forms.ts";
import { hRate, rate, rateAux, HIT_BIP_ADJ, PIT_BIP_ADJ, LOG, type EventForm } from "../src/model/curves.ts";
import { HITTER, PITCHER, actualHitWoba, actualPitWoba } from "../src/training/bakeoff.ts";
import { wPearson } from "../src/training/metrics.ts";

const TH = 500;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3), thr = (x: string) => (x === "R" ? 1 : 2);

// ── league fits: OLD (fitted log-BIP term) vs NEW (unit elasticity) ────────────
const LDIR = "League Files";
const years = availableYears(LDIR).slice(-2);
const { observations } = loadWindow(LDIR, years);
const hitObs = observations.filter((o) => o.hit.PA >= 1000);
const pitObs = observations.filter((o) => o.pitch.BF >= 1000);
console.log(`league window: ${years.join("+")}  hitObs=${hitObs.length}  pitObs=${pitObs.length}`);

const OLD_HIT: HitForm = { ...RAWPOLY_HIT, name: "old(logBIP)", hBip: LOG };
const OLD_PIT: PitForm = { ...STUFFAUG_PIT, name: "old(logBIP)", hBip: LOG };
const forms: Record<string, EventForm> = {
  old: { hit: fitHitForm(OLD_HIT, hitObs), pit: fitPitForm(OLD_PIT, pitObs) },
  new: { hit: fitHitForm(RAWPOLY_HIT, hitObs), pit: fitPitForm(STUFFAUG_PIT, pitObs) },
};

// ── fitted H-curve anatomy: what elasticity did the old fit actually pick? ─────
// Old design: H = a + b·ln(babip) + c·ln(BIP) → elasticity dlnH/dlnBIP = c/H.
// Unit form pins that elasticity to exactly 1. Report c and the implied league
// elasticity so the direction of the EG bias delta is interpretable.
{
  const meanHitH = hitObs.reduce((s, o) => s + (o.hit.H - o.hit.HR) / Math.max(o.hit.PA, 1) * 600, 0) / hitObs.length;
  const meanPitH = pitObs.reduce((s, o) => s + (o.pitch.b1 + o.pitch.b2 + o.pitch.b3) / Math.max(o.pitch.BF, 1) * 600, 0) / pitObs.length;
  const co = forms.old!;
  const cHit = co.hit.h.beta[2]!, cPit = co.pit.h.beta[2]!;
  console.log(`\nfitted log-BIP coefficient (old form): hit c=${cHit.toFixed(1)} (implied elasticity ≈ ${(cHit / meanHitH).toFixed(2)} at league mean H=${meanHitH.toFixed(1)}), pit c=${cPit.toFixed(1)} (≈ ${(cPit / meanPitH).toFixed(2)} at H=${meanPitH.toFixed(1)}); unit form pins elasticity = 1.00`);
}

// ── league in-sample fit quality (should be near-identical) ────────────────────
console.log(`\n=== League in-sample fit quality (wOBA Pearson, PA/BF^0.75-weighted; H-event RMSE per 600) ===`);
const rmseW = (p: number[], a: number[], w: number[]) => Math.sqrt(p.reduce((s, v, i) => s + w[i]! * (v - a[i]!) ** 2, 0) / w.reduce((s, v) => s + v, 0));
for (const which of ["old", "new"] as const) {
  const f = forms[which]!;
  const hw = hitObs.map(HITTER.weight), pw = pitObs.map(PITCHER.weight);
  const hPred = hitObs.map((o) => predictHitForm(f.hit, o)), hAct = hitObs.map(actualHitWoba);
  const pPred = pitObs.map((o) => predictPitForm(f.pit, o)), pAct = pitObs.map(actualPitWoba);
  console.log(`  ${which}: hit wOBA r=${wPearson(hPred, hAct, hw).toFixed(5)} rmse=${rmseW(hPred, hAct, hw).toFixed(5)}  |  pit wOBA r=${wPearson(pPred, pAct, pw).toFixed(5)} rmse=${rmseW(pPred, pAct, pw).toFixed(5)}`);
}
// H-event in-sample comparison (non-HR hits per 600): predicted through each form's own chain.
console.log(`  H-event (non-HR hits/600) in-sample:`);
for (const which of ["old", "new"] as const) {
  const f = forms[which]!;
  const hw = hitObs.map(HITTER.weight), pw = pitObs.map(PITCHER.weight);
  const hPred = hitObs.map((o) => { const r = o.ratings.hit; const bip = Math.max(600 - rate(f.hit.bb, r.eye) - rate(f.hit.k, r.kRat) - rate(f.hit.hr, r.pow) - HIT_BIP_ADJ, 1); return hRate(f.hit.h, r.babip, bip); });
  const hAct = hitObs.map((o) => (o.hit.H - o.hit.HR) / Math.max(o.hit.PA, 1) * 600);
  const pPred = pitObs.map((o) => { const r = o.ratings.pitch; const bip = Math.max(600 - rateAux(f.pit.bb, r.con, r.stu) - rate(f.pit.k, r.stu) - rateAux(f.pit.hr, r.hrr, r.stu) - PIT_BIP_ADJ, 1); return hRate(f.pit.h, r.pbabip, bip); });
  const pAct = pitObs.map((o) => (o.pitch.b1 + o.pitch.b2 + o.pitch.b3) / Math.max(o.pitch.BF, 1) * 600);
  console.log(`    ${which}: hit H r=${wPearson(hPred, hAct, hw).toFixed(5)} rmse=${rmseW(hPred, hAct, hw).toFixed(4)}  |  pit H r=${wPearson(pPred, pAct, pw).toFixed(5)} rmse=${rmseW(pPred, pAct, pw).toFixed(4)}`);
}

// ── tournament configs ──────────────────────────────────────────────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");

const EV = ["BB", "K", "HR", "oneB", "XBH"] as const;
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

interface Agg { r: any; hPA: number; hBB: number; hIBB: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number; pBF: number; pBB: number; pIBB: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }

function runTournament(tdir: string, tid: string) {
  const t = tournaments.find((x) => x.id === tid)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  const derived = computeDerived(coeffs, true);

  const m = new Map<string, Agg>();
  let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
  for (const f of readdirSync(tdir).filter((x) => x.endsWith(".csv"))) {
    for (const r of Papa.parse(readFileSync(`${tdir}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
      const pa = num(r.PA), bf = num(r.BF);
      if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
      if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
      const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
      if (!a) { a = { r, hPA: 0, hBB: 0, hIBB: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, pBF: 0, pBB: 0, pIBB: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 }; m.set(key, a); }
      a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
      a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
    }
  }
  const wRhit = bfR / bfAll, wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
  const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
  const hRat = (r: any, s: string) => ({ eye: R(r, s, "EYE"), pow: R(r, s, "POW"), kRat: R(r, s, "K"), babip: R(r, s, "BA"), gap: R(r, s, "GAP"), speed: 0, steal: 0, run: 0 });
  const pRat = (r: any, s: string) => ({ con: R(r, s, "CON"), stu: R(r, s, "STU"), pbabip: R(r, s, "PBABIP"), hrr: R(r, s, "HRA") });
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  const leagueHit = (form: EventForm, r: any) => {
    const rp = makeRawPolyModel(form);
    const side = (s: "vR" | "vL") => { const e = rp.predictHitting(hRat(r, s), coeffs); const k = hittingComponents(e, 1, 1, bats(String(r.B)), s, coeffs, derived, form); return { BB: k.BB_fin, K: e.SO * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; };
    const A = side("vR"), B = side("vL"), o: any = {};
    for (const k of EV) o[k] = bl((A as any)[k], (B as any)[k], wRhit);
    return o;
  };
  const leaguePit = (form: EventForm, r: any) => {
    const rp = makeRawPolyModel(form);
    const w = wRpit[thr(String(r.T))]!;
    const side = (s: "vR" | "vL") => { const e = rp.predictPitching(pRat(r, s), coeffs); const k = pitchingComponents(e, 1, 1, s, coeffs, derived, form); return { BB: k.BB_fin, K: e.K * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; };
    const A = side("vR"), B = side("vL"), o: any = {};
    for (const k of EV) o[k] = bl((A as any)[k], (B as any)[k], w);
    return o;
  };

  for (const role of ["hit", "pit"] as const) {
    const cs = [...m.values()].filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
    const w = cs.map((a) => (role === "hit" ? a.hPA : a.pBF));
    const g = (a: Agg, n: number) => n * 600 / (role === "hit" ? a.hPA : a.pBF);
    const act = (a: Agg): any => role === "hit"
      ? { BB: g(a, a.hBB), uBB: g(a, a.hBB - a.hIBB), K: g(a, a.hK), HR: g(a, a.hHR), oneB: g(a, a.h1B), XBH: g(a, a.h2B + a.h3B) }
      : { BB: g(a, a.pBB), uBB: g(a, a.pBB - a.pIBB), K: g(a, a.pK), HR: g(a, a.pHR), oneB: g(a, a.p1B), XBH: g(a, a.p2B + a.p3B) };
    console.log(`\n=== ${tid} ${role === "hit" ? "HITTER" : "PITCHER"} level bias, mean(pred − act) per 600 (n=${cs.length}, ${role === "hit" ? "PA" : "BF"}-weighted, PT OFF) ===`);
    console.log(`               ${EV.map((e) => e.padStart(7)).join("")}   BBvsUBB`);
    for (const which of ["old", "new"] as const) {
      const pred = cs.map((a) => (role === "hit" ? leagueHit(forms[which]!, a.r) : leaguePit(forms[which]!, a.r)));
      const cells = EV.map((ev) => (wmean(pred.map((p) => p[ev]), w) - wmean(cs.map((a) => act(a)[ev]), w)).toFixed(1).padStart(7));
      const ubbBias = (wmean(pred.map((p) => p.BB), w) - wmean(cs.map((a) => act(a).uBB), w)).toFixed(1).padStart(7);
      const adj = role === "hit" ? HIT_BIP_ADJ : PIT_BIP_ADJ;
      const bipMean = wmean(pred.map((p) => 600 - p.BB - p.K - p.HR - adj), w);
      console.log(`  form=${which}    ${cells.join("")}   ${ubbBias}   (mean pred BIP_fin ≈ ${bipMean.toFixed(0)})`);
    }
    const actual = ["BB", "K", "HR", "oneB", "XBH", "uBB"].map((ev) => wmean(cs.map((a) => act(a)[ev]), w).toFixed(1).padStart(7));
    console.log(`  (actual)     ${actual.slice(0, 5).join("")}   ${actual[5]}  (last col = uBB actual)`);
  }
}

runTournament("Tournament Data/Early Gold", "early-gold");
runTournament("Tournament Data/Return of the Bronze", "bronze-return");
process.exit(0);
