// For a tournament: (1) derive LEVEL-CALIBRATED era factors (scale so predicted event MEANS match
// actual) SEPARATELY for hitters and pitchers, vs the library factors; (2) show EYE→BB / CON→BB
// residuals with the tournament adjustment OFF vs the shipped HR1.15/BB0.85 ON.
//   run: node tools/tournament-factors.ts [tid] [dir]

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, type Coeffs, type Derived } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TID = process.argv[2] ?? "early-gold";
const TDIR = process.argv[3] ?? "Tournament Data/Early Gold";
const TH = 500, num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3), thr = (x: string) => (x === "R" ? 1 : 2);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm: EventForm = trained.eventForm;
const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const W = wobaWeightsFromCoeffs(coeffs), HBP = coeffs.adv_hbp ?? 6;
const rp = makeRawPolyModel(eventForm);
console.log(`\n=== ${t.name} (era ${t.eraId} / park ${t.parkId}) — level-calibrated factors + adjustment test ===`);
console.log(`library era factors: era_bb ${coeffs.era_bb.toFixed(3)}  era_k ${coeffs.era_k.toFixed(3)}  era_hr(eff) ${derived.era_effective_hr.toFixed(3)}  era_h ${derived.era_h.toFixed(3)}  era_gap ${coeffs.era_gap.toFixed(3)}`);

interface Agg { r: any; hPA: number; hBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number; pBF: number; pBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
const m = new Map<string, Agg>(); let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
  const pa = num(r.PA), bf = num(r.BF); if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; } if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
  const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
  if (!a) { a = { r, hPA: 0, hBB: 0, hHP: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, pBF: 0, pBB: 0, pHP: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 }; m.set(key, a); }
  a.hPA += pa; a.hBB += num(r.BB); a.hHP += num(r.HP); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
  a.pBF += bf; a.pBB += num(r.BB_1); a.pHP += num(r.HP_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
}
const wRhit = bfR / bfAll, wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const hRat = (r: any, s: string) => ({ eye: R(r, s, "EYE"), pow: R(r, s, "POW"), kRat: R(r, s, "K"), babip: R(r, s, "BA"), gap: R(r, s, "GAP"), speed: 0, steal: 0, run: 0 });
const pRat = (r: any, s: string) => ({ con: R(r, s, "CON"), stu: R(r, s, "STU"), pbabip: R(r, s, "PBABIP"), hrr: R(r, s, "HRA") });
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
const wmean = (x: number[], w: number[]) => x.reduce((s, v, i) => s + v * w[i]!, 0) / w.reduce((s, v) => s + v, 0);

// predicted event means with an env adjustment (aHR,aBB); returns per-role weighted means of predicted events
const env = (aHR: number, aBB: number): { c: Coeffs; d: Derived } => { const c = { ...coeffs, era_bb: coeffs.era_bb * aBB } as Coeffs; const d = computeDerived(c, true); d.era_effective_hr *= aHR; return { c, d }; };
const hPredEv = (r: any, c: Coeffs, d: Derived) => { const side = (s: "vR" | "vL") => { const e = rp.predictHitting(hRat(r, s), c); const k = hittingComponents(e, 1, 1, bats(String(r.B)), s, c, d, eventForm); return { BB: k.BB_fin, K: e.SO * c.era_k, HR: k.HR_fin, nHH: k.oneB_fin + k.GAP_fin, XBH: k.GAP_fin }; }; const A = side("vR"), B = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "nHH", "XBH"]) o[k] = bl((A as any)[k], (B as any)[k], wRhit); return o; };
const pPredEv = (r: any, c: Coeffs, d: Derived) => { const w = wRpit[thr(String(r.T))]!; const side = (s: "vR" | "vL") => { const e = rp.predictPitching(pRat(r, s), c); const k = pitchingComponents(e, 1, 1, s, c, d, eventForm); return { BB: k.BB_fin, K: e.K * c.era_k, HR: k.HR_fin, nHH: k.oneB_fin + k.XBH_fin, XBH: k.XBH_fin }; }; const A = side("vR"), B = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "nHH", "XBH"]) o[k] = bl((A as any)[k], (B as any)[k], w); return o; };

const roleFactors = (role: "hit" | "pit") => {
  const cs = [...m.values()].filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
  const w = cs.map((a) => role === "hit" ? a.hPA : a.pBF);
  const g = (a: Agg, n: number) => n * 600 / (role === "hit" ? a.hPA : a.pBF);
  const actMean = { BB: wmean(cs.map((a) => role === "hit" ? g(a, a.hBB) : g(a, a.pBB)), w), K: wmean(cs.map((a) => role === "hit" ? g(a, a.hK) : g(a, a.pK)), w), HR: wmean(cs.map((a) => role === "hit" ? g(a, a.hHR) : g(a, a.pHR)), w), nHH: wmean(cs.map((a) => role === "hit" ? g(a, a.h1B + a.h2B + a.h3B) : g(a, a.p1B + a.p2B + a.p3B)), w), XBH: wmean(cs.map((a) => role === "hit" ? g(a, a.h2B + a.h3B) : g(a, a.p2B + a.p3B)), w) };
  const pred = cs.map((a) => role === "hit" ? hPredEv(a.r, coeffs, derived) : pPredEv(a.r, coeffs, derived));
  const predMean = { BB: wmean(pred.map((p) => p.BB), w), K: wmean(pred.map((p) => p.K), w), HR: wmean(pred.map((p) => p.HR), w), nHH: wmean(pred.map((p) => p.nHH), w), XBH: wmean(pred.map((p) => p.XBH), w) };
  const lib = { BB: coeffs.era_bb, K: coeffs.era_k, HR: derived.era_effective_hr, nHH: derived.era_h, XBH: coeffs.era_gap };
  return { n: cs.length, actMean, predMean, lib };
};
for (const [role, label] of [["hit", "HITTERS"], ["pit", "PITCHERS"]] as const) {
  const f = roleFactors(role);
  console.log(`\n${label} (n=${f.n}) — trained factor = library × (actual/predicted):`);
  console.log(`   event    actual/600  pred/600   ratio   LIBRARY→TRAINED`);
  for (const [ev, fac] of [["BB", "era_bb"], ["K", "era_k"], ["HR", "era_hr"], ["nHH", "era_h"], ["XBH", "era_gap"]] as const) {
    const a = (f.actMean as any)[ev], p = (f.predMean as any)[ev], l = (f.lib as any)[ev]; const ratio = a / p;
    console.log(`   ${ev.padEnd(6)} ${a.toFixed(1).padStart(9)} ${p.toFixed(1).padStart(10)} ${ratio.toFixed(3).padStart(8)}   ${fac} ${l.toFixed(3)} → ${(l * ratio).toFixed(3)}`);
  }
}

// adjustment test: EYE→BB (hitters) and CON→BB (pitchers) residual with adj OFF vs shipped ON
const residSlope = (pred: number[], act: number[], w: number[], rat: number[]) => { const mx = wmean(pred, w), my = wmean(act, w); let cxy = 0, cxx = 0; for (let i = 0; i < pred.length; i++) { cxy += w[i]! * (pred[i]! - mx) * (act[i]! - my); cxx += w[i]! * (pred[i]! - mx) ** 2; } const b = cxy / cxx, a0 = my - b * mx; const res = pred.map((p, i) => act[i]! - (a0 + b * p)); const mr = wmean(rat, w), sd = Math.sqrt(wmean(rat.map((v) => (v - mr) ** 2), w)) || 1; const z = rat.map((v) => (v - mr) / sd); const mres = wmean(res, w); let cz = 0, zz = 0; for (let i = 0; i < res.length; i++) { cz += w[i]! * z[i]! * (res[i]! - mres); zz += w[i]! * z[i]! ** 2; } return (cz / zz) * 1000; };
const asm = (e: any, k: any) => (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * (k.GAP_fin ?? k.XBH_fin) + W.hr * k.HR_fin) / 600;
const hWoba = (r: any, c: Coeffs, d: Derived) => { const s = (side: "vR" | "vL") => { const e = rp.predictHitting(hRat(r, side), c); return asm(e, hittingComponents(e, 1, 1, bats(String(r.B)), side, c, d, eventForm)); }; return bl(s("vR"), s("vL"), wRhit); };
const pWoba = (r: any, c: Coeffs, d: Derived) => { const w = wRpit[thr(String(r.T))]!; const s = (side: "vR" | "vL") => { const e = rp.predictPitching(pRat(r, side), c); return asm(e, pitchingComponents(e, 1, 1, side, c, d, eventForm)); }; return bl(s("vR"), s("vL"), w); };
const Hc = [...m.values()].filter((a) => a.hPA >= TH), Pc = [...m.values()].filter((a) => a.pBF >= TH);
const hw = Hc.map((a) => a.hPA), pw = Pc.map((a) => a.pBF);
const hAct = Hc.map((a) => (W.bb * a.hBB + W.hbp * a.hHP + W.b1 * a.h1B + W.xbh * (a.h2B + a.h3B) + W.hr * a.hHR) / a.hPA);
const pAct = Pc.map((a) => (W.bb * a.pBB + W.hbp * a.pHP + W.b1 * a.p1B + W.xbh * (a.p2B + a.p3B) + W.hr * a.pHR) / a.pBF);
console.log(`\nadjustment test (EYE→BB hitters, CON→BB pitchers; want ≈0):`);
for (const [lbl, aHR, aBB] of [["adj OFF (1.0/1.0)", 1, 1], ["shipped ON (1.15/0.85)", 1.15, 0.85]] as const) {
  const { c, d } = env(aHR, aBB);
  console.log(`   ${lbl.padEnd(24)} EYE→BB ${residSlope(Hc.map((a) => hWoba(a.r, c, d)), hAct, hw, Hc.map((a) => R(a.r, "vR", "EYE"))).toFixed(2)}   CON→BB ${residSlope(Pc.map((a) => pWoba(a.r, c, d)), pAct, pw, Pc.map((a) => R(a.r, "vR", "CON"))).toFixed(2)}`);
}
process.exit(0);
