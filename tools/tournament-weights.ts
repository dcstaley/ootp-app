// THROWAWAY (do not commit): derive era-1920 wOBA weights from Early Gold's own wRAA
// column and test whether era-specific weights shrink the EYE/BABIP residual bias that
// the deployed LEAGUE model shows on dead-ball data.
//
// Mirrors:
//   - tools/tournament-validate.ts  (boot, per-(CID,VLvl) aggregation, exposure, residSlope)
//   - src/training/loader.ts 195-274 (no-intercept wRAA regression → weights rel. 1B → XBH blend)
//
//   run: node tools/tournament-weights.ts

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, type Coeffs, type Derived } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { DEFAULT_WOBA_WEIGHTS, type WobaWeights } from "../src/scoring-core/woba-weights.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TDIR = "Tournament Data/Early Gold";
const TID = "early-gold";
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// ── Boot config like the server / the validate harness ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
const trained = state.activeModelId ? (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId) : undefined;
const eventForm = trained?.eventForm!;
const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
if (trained?.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const LEAGUE_W = wobaWeightsFromCoeffs(coeffs); // the deployed league weights
const rp = makeRawPolyModel(eventForm);
const HBP = coeffs.adv_hbp ?? 6;
console.log(`\n=== era-1920 wOBA-weight derivation — Early Gold, env era ${t.eraId} / park ${t.parkId}, model ${state.activeModelId} ===`);

// ── solveNormal — copied verbatim from loader.ts (no-intercept normal equations) ──
function solveNormal(X: number[][], y: number[]): number[] {
  const p = X[0]!.length, A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < X.length; i++) { for (let j = 0; j < p; j++) { for (let k = 0; k < p; k++) A[j]![k] += X[i]![j]! * X[i]![k]!; A[j]![p] += X[i]![j]! * y[i]!; } }
  for (let c = 0; c < p; c++) {
    let m = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[m]![c]!)) m = r;
    [A[c], A[m]] = [A[m]!, A[c]!];
    const pv = A[c]![c]!; if (Math.abs(pv) < 1e-12) continue;
    for (let k = c; k <= p; k++) A[c]![k] /= pv;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r]![c]!; for (let k = c; k <= p; k++) A[r]![k] -= f * A[c]![k]!; }
  }
  return A.map((r) => r[p]!);
}

// ── Aggregate per (CID, VLvl) across all 7 daily files (same as validate) ──
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3);
const thr = (x: string) => (x === "R" ? 1 : 2);
interface Agg { r: Record<string, unknown>; hPA: number; hBB: number; hIBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number; hWRAA: number;
  pBF: number; pBB: number; pIBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
const agg = new Map<string, Agg>();
let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
// Row-grain wRAA regression rows (PA>=50), across ALL daily files (each row is one day's line).
const rowX: number[][] = [], rowY: number[] = []; let rowN2 = 0, rowN3 = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  const rows = Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as Record<string, unknown>[];
  for (const r of rows) {
    const bf = num(r.BF), pa = num(r.PA);
    if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
    if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
    // per-ROW regression input (X = [BB-IBB, HBP, 1B, 2B, 3B, HR, PA], Y = wRAA)
    if (pa >= 50) {
      const bb = num(r.BB) - num(r.IBB), hp = num(r.HP), b1 = num(r["1B_1"]), b2 = num(r["2B_1"]), b3 = num(r["3B_1"]), hr = num(r.HR);
      rowX.push([bb, hp, b1, b2, b3, hr, pa]); rowY.push(num(r.wRAA)); rowN2 += b2; rowN3 += b3;
    }
    const key = `${r.CID}|${r.VLvl}`;
    let a = agg.get(key);
    if (!a) { a = { r, hPA: 0, hBB: 0, hIBB: 0, hHP: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, hWRAA: 0, pBF: 0, pBB: 0, pIBB: 0, pHP: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 }; agg.set(key, a); }
    a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.hHP += num(r.HP); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K); a.hWRAA += num(r.wRAA);
    a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.pHP += num(r.HP_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
  }
}
const paTot = paR + paL + paS;
const wRhit = bfR / bfAll;
const wRpit: Record<number, number> = { 1: paR / paTot, 2: (paR + paS) / paTot };

// ── Derive weights from a set of regression rows, mirroring loader.ts 228-274 ──
function deriveWeights(X: number[][], Y: number[], n2: number, n3: number, label: string): WobaWeights {
  const b = solveNormal(X, Y);
  const oneB = b[2]!;
  const A = DEFAULT_WOBA_WEIGHTS.b1; // anchor 1B to conventional value (0.8992)
  // raw relative-to-1B coefficients (before anchoring)
  const rel = { bb: b[0]! / oneB, hbp: b[1]! / oneB, b2: b[3]! / oneB, b3: b[4]! / oneB, hr: b[5]! / oneB };
  const w2 = rel.b2 * A, w3 = rel.b3 * A;
  const xbh = n2 + n3 > 0 ? (n2 * w2 + n3 * w3) / (n2 + n3) : DEFAULT_WOBA_WEIGHTS.xbh;
  const W: WobaWeights = { bb: rel.bb * A, hbp: rel.hbp * A, b1: A, xbh, hr: rel.hr * A };
  console.log(`\n  [${label}] n=${X.length} rows; raw 1B coef b_1B=${oneB.toExponential(3)} (PA coef=${b[6]!.toExponential(3)} = -lg/scale)`);
  console.log(`             rel-to-1B: bb ${rel.bb.toFixed(3)}  hbp ${rel.hbp.toFixed(3)}  2B ${rel.b2.toFixed(3)}  3B ${rel.b3.toFixed(3)}  hr ${rel.hr.toFixed(3)}  (2B:3B mix ${n2}:${n3})`);
  return W;
}

// (a) ROW-grain (PA>=50 per daily line)
const W_row = deriveWeights(rowX, rowY, rowN2, rowN3, "row-grain PA>=50");

// (b) AGGREGATED per-card, PA-weighted (preferred for stability): one regression row per card,
//     using season-summed events + summed wRAA. Weight each card by sqrt(PA) so big-sample cards
//     dominate the fit (loader PA-weights across FILES; here we weight across CARDS by replicating
//     the linear system — equivalent to scaling each row by its weight since the form has no intercept).
const aggX: number[][] = [], aggY: number[] = []; let aggN2 = 0, aggN3 = 0;
for (const a of agg.values()) {
  if (a.hPA < 50) continue;
  const bb = a.hBB - a.hIBB;
  // PA-weight the row: multiply both sides by w so larger cards carry more (no-intercept ⇒ valid).
  const w = Math.sqrt(a.hPA);
  aggX.push([bb * w, a.hHP * w, a.h1B * w, a.h2B * w, a.h3B * w, a.hHR * w, a.hPA * w]);
  aggY.push(a.hWRAA * w);
  aggN2 += a.h2B; aggN3 += a.h3B;
}
const W_agg = deriveWeights(aggX, aggY, aggN2, aggN3, "aggregated-per-card, sqrt(PA)-weighted");

// ── Side-by-side table ──
const ERA_W = W_agg; // use the aggregated fit as the era-1920 estimate (preferred)
const fmt = (n: number) => n.toFixed(3).padStart(7);
console.log(`\n── DERIVED era-1920 weights  vs  deployed LEAGUE weights ──`);
console.log(`  weight     league    era1920(agg)  era1920(row)   Δ(agg-league)   ratio(agg/league)`);
const wkeys: (keyof WobaWeights)[] = ["bb", "hbp", "b1", "xbh", "hr"];
for (const k of wkeys) {
  const d = W_agg[k] - LEAGUE_W[k], ratio = W_agg[k] / LEAGUE_W[k];
  console.log(`  ${k.padEnd(6)} ${fmt(LEAGUE_W[k])}     ${fmt(W_agg[k])}     ${fmt(W_row[k])}     ${d >= 0 ? "+" : ""}${d.toFixed(3).padStart(6)}        ${ratio.toFixed(3)}`);
}
// Spread diagnostics: BB relative to 1B, and HR relative to 1B, and full HR/BB.
const spread = (W: WobaWeights) => ({ bbrel: W.bb / W.b1, hrrel: W.hr / W.b1, hrbb: W.hr / W.bb });
const sL = spread(LEAGUE_W), sA = spread(W_agg);
console.log(`\n  spread:   bb/1B   league ${sL.bbrel.toFixed(3)}  era ${sA.bbrel.toFixed(3)}   |   hr/1B  league ${sL.hrrel.toFixed(3)}  era ${sA.hrrel.toFixed(3)}   |   hr/bb  league ${sL.hrbb.toFixed(3)}  era ${sA.hrbb.toFixed(3)}`);

// ── Build cards (same as validate) ──
interface Card { hitVR: any; hitVL: any; pitVR: any; pitVL: any; bats: number; thr: number;
  hPA: number; pBF: number; eye: number; pow: number; babip: number; gap: number; kRat: number;
  stu: number; con: number; hra: number; pbabip: number;
  hBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number;
  pBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number }
const cards: Card[] = [];
for (const a of agg.values()) {
  const r = a.r;
  const R = (s: string, col: string) => num(r[`${col} ${s}`]);
  const hR = { eye: R("vR", "EYE"), pow: R("vR", "POW"), kRat: R("vR", "K"), babip: R("vR", "BA"), gap: R("vR", "GAP"), speed: 0, steal: 0, run: 0 };
  const hL = { eye: R("vL", "EYE"), pow: R("vL", "POW"), kRat: R("vL", "K"), babip: R("vL", "BA"), gap: R("vL", "GAP"), speed: 0, steal: 0, run: 0 };
  const pR = { con: R("vR", "CON"), stu: R("vR", "STU"), pbabip: R("vR", "PBABIP"), hrr: R("vR", "HRA") };
  const pL = { con: R("vL", "CON"), stu: R("vL", "STU"), pbabip: R("vL", "PBABIP"), hrr: R("vL", "HRA") };
  cards.push({
    hitVR: rp.predictHitting(hR, coeffs), hitVL: rp.predictHitting(hL, coeffs),
    pitVR: rp.predictPitching(pR, coeffs), pitVL: rp.predictPitching(pL, coeffs),
    bats: bats(String(r.B)), thr: thr(String(r.T)),
    hPA: a.hPA, pBF: a.pBF,
    eye: R("vR", "EYE"), pow: R("vR", "POW"), babip: R("vR", "BA"), gap: R("vR", "GAP"), kRat: R("vR", "K"),
    stu: R("vR", "STU"), con: R("vR", "CON"), hra: R("vR", "HRA"), pbabip: R("vR", "PBABIP"),
    hBB: a.hBB - a.hIBB, hHP: a.hHP, h1B: a.h1B, h2B: a.h2B, h3B: a.h3B, hHR: a.hHR,
    pBB: a.pBB - a.pIBB, pHP: a.pHP, p1B: a.p1B, p2B: a.p2B, p3B: a.p3B, pHR: a.pHR,
  });
}

// ── Predicted / actual wOBA under a GIVEN weight vector (same weights both sides = fair test) ──
const base = { c: coeffs, d: computeDerived(coeffs, true) };
const hitPredW = (card: Card, W: WobaWeights) => {
  const one = (e: any, side: "vR" | "vL") => { const k = hittingComponents(e, 1, 1, card.bats, side, base.c, base.d, eventForm); return (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * k.GAP_fin + W.hr * k.HR_fin) / 600; };
  return wRhit * one(card.hitVR, "vR") + (1 - wRhit) * one(card.hitVL, "vL");
};
const pitPredW = (card: Card, W: WobaWeights) => {
  const one = (e: any, side: "vR" | "vL") => { const k = pitchingComponents(e, 1, 1, side, base.c, base.d, eventForm); return (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * k.XBH_fin + W.hr * k.HR_fin) / 600; };
  const w = wRpit[card.thr]!; return w * one(card.pitVR, "vR") + (1 - w) * one(card.pitVL, "vL");
};
const hActW = (c: Card, W: WobaWeights) => c.hPA > 0 ? (W.bb * c.hBB + W.hbp * c.hHP + W.b1 * c.h1B + W.xbh * (c.h2B + c.h3B) + W.hr * c.hHR) / c.hPA : 0;
const pActW = (c: Card, W: WobaWeights) => c.pBF > 0 ? (W.bb * c.pBB + W.hbp * c.pHP + W.b1 * c.p1B + W.xbh * (c.p2B + c.p3B) + W.hr * c.pHR) / c.pBF : 0;

// ── Stats helpers (from validate) ──
const wmean = (xs: number[], ws: number[]) => xs.reduce((s, x, i) => s + x * ws[i]!, 0) / ws.reduce((s, x) => s + x, 0);
const wpearson = (xs: number[], ys: number[], ws: number[]) => { const mx = wmean(xs, ws), my = wmean(ys, ws); let a = 0, b = 0, c = 0; for (let i = 0; i < xs.length; i++) { const w = ws[i]!, dx = xs[i]! - mx, dy = ys[i]! - my; a += w * dx * dy; b += w * dx * dx; c += w * dy * dy; } return a / Math.sqrt(b * c); };
const residSlope = (recs: { pred: number; act: number; w: number; rat: number }[]) => {
  const xs = recs.map((r) => r.pred), ys = recs.map((r) => r.act), ws = recs.map((r) => r.w);
  const mx = wmean(xs, ws), my = wmean(ys, ws); let cxy = 0, cxx = 0; for (let i = 0; i < xs.length; i++) { cxy += ws[i]! * (xs[i]! - mx) * (ys[i]! - my); cxx += ws[i]! * (xs[i]! - mx) ** 2; }
  const b = cxy / cxx, a0 = my - b * mx; const res = recs.map((r) => r.act - (a0 + b * r.pred));
  const rv = recs.map((r) => r.rat), mr = wmean(rv, ws), sd = Math.sqrt(wmean(rv.map((v) => (v - mr) ** 2), ws)) || 1;
  const z = rv.map((v) => (v - mr) / sd); const mres = wmean(res, ws); let cz = 0, zz = 0;
  for (let i = 0; i < res.length; i++) { cz += ws[i]! * z[i]! * (res[i]! - mres); zz += ws[i]! * z[i]! ** 2; }
  return (cz / zz) * 1000;
};

// ── The key test: residual bias under LEAGUE weights vs ERA-1920 weights ──
const FIT = 500;
const H = cards.filter((c) => c.hPA >= FIT), P = cards.filter((c) => c.pBF >= FIT);
function biasReport(label: string, W: WobaWeights) {
  const hEYE = residSlope(H.map((x) => ({ pred: hitPredW(x, W), act: hActW(x, W), w: x.hPA, rat: x.eye })));
  const hBAB = residSlope(H.map((x) => ({ pred: hitPredW(x, W), act: hActW(x, W), w: x.hPA, rat: x.babip })));
  const hPOW = residSlope(H.map((x) => ({ pred: hitPredW(x, W), act: hActW(x, W), w: x.hPA, rat: x.pow })));
  const hGAP = residSlope(H.map((x) => ({ pred: hitPredW(x, W), act: hActW(x, W), w: x.hPA, rat: x.gap })));
  const pCON = residSlope(P.map((x) => ({ pred: pitPredW(x, W), act: pActW(x, W), w: x.pBF, rat: x.con })));
  const pSTU = residSlope(P.map((x) => ({ pred: pitPredW(x, W), act: pActW(x, W), w: x.pBF, rat: x.stu })));
  const hP = wpearson(H.map((x) => hitPredW(x, W)), H.map((x) => hActW(x, W)), H.map((x) => x.hPA));
  const pP = wpearson(P.map((x) => pitPredW(x, W)), P.map((x) => pActW(x, W)), P.map((x) => x.pBF));
  console.log(`  ${label.padEnd(22)} hitP ${hP.toFixed(3)} pitP ${pP.toFixed(3)} | HIT resid EYE ${hEYE.toFixed(2).padStart(6)} BABIP ${hBAB.toFixed(2).padStart(6)} POW ${hPOW.toFixed(2).padStart(6)} GAP ${hGAP.toFixed(2).padStart(6)} | PIT CON ${pCON.toFixed(2).padStart(6)} STU ${pSTU.toFixed(2).padStart(6)}`);
  return { hEYE, hBAB };
}
console.log(`\n── KEY TEST: residual-bias slopes under each weight vector (≥${FIT} PA/BF: ${H.length} hitters / ${P.length} pitchers; wOBA pts/SD, want ≈0) ──`);
const bLeague = biasReport("league weights", LEAGUE_W);
const bEraAgg = biasReport("era-1920 (agg)", W_agg);
const bEraRow = biasReport("era-1920 (row)", W_row);
console.log(`\n  EYE   bias: league ${bLeague.hEYE.toFixed(2)}  →  era-agg ${bEraAgg.hEYE.toFixed(2)}  (era-row ${bEraRow.hEYE.toFixed(2)})   shrink ${(100 * (1 - Math.abs(bEraAgg.hEYE) / Math.abs(bLeague.hEYE))).toFixed(0)}%`);
console.log(`  BABIP bias: league ${bLeague.hBAB.toFixed(2)}  →  era-agg ${bEraAgg.hBAB.toFixed(2)}  (era-row ${bEraRow.hBAB.toFixed(2)})   shrink ${(100 * (1 - Math.abs(bEraAgg.hBAB) / Math.abs(bLeague.hBAB))).toFixed(0)}%`);
process.exit(0);
