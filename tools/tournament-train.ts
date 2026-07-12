// THROWAWAY — build a NATIVE tournament-specific scoring model on Early Gold real
// outcomes (era-1920 dead-ball, park-169) and compare it head-to-head with the
// deployed LEAGUE model on true out-of-sample (held-out day) outcomes.
//
//   • NATIVE (bake) model: fit fitHitForm(RAWPOLY_HIT)/fitPitForm(STUFFAUG_PIT) directly
//     on the raw combined tournament outcomes. Env is BAKED into the fit → predict wOBA
//     directly (NO era/park at predict time).
//   • Because tournament outcomes are COMBINED (no vL/vR split), build EXPOSURE-BLENDED
//     ratings per card (blend vR/vL at the derived exposure), then fit on the combined
//     totals. ("Blend ratings then fit" ≈ the true blended-prediction model — caveat.)
//   • Hold out by DAY: fit on July 5-9, evaluate on July 10-11 (same cards, fresh games).
//
//   run: node tools/tournament-train.ts

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, type Coeffs, type Derived } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { fitHitForm, fitPitForm, predictHitForm, predictPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../src/training/forms.ts";
import type { TrainObs } from "../src/training/loader.ts";
import { rate, rateAux, hRate, HIT_BIP_ADJ, PIT_BIP_ADJ } from "../src/model/curves.ts";

const TDIR = "Tournament Data/Early Gold";
const TID = "early-gold";
const TRAIN_DAYS = new Set([5, 6, 7, 8, 9]);
const TEST_DAYS = new Set([10, 11]);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// ── Boot config like the server ──
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
const W = wobaWeightsFromCoeffs(coeffs);
const rp = makeRawPolyModel(eventForm);
const HBP = coeffs.adv_hbp ?? 6;
console.log(`\n=== NATIVE tournament model vs LEAGUE model — Early Gold, era ${t.eraId} / park ${t.parkId}, league-model ${state.activeModelId} ===`);

// ── Aggregate per (CID, VLvl) SEPARATELY for train days & test days; tally handedness (all days) ──
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3);
const thr = (x: string) => (x === "R" ? 1 : 2);
interface Agg { r: Record<string, unknown>; hPA: number; hBB: number; hIBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number;
  pBF: number; pBB: number; pIBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
const zeroAgg = (r: Record<string, unknown>): Agg => ({ r, hPA: 0, hBB: 0, hIBB: 0, hHP: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, pBF: 0, pBB: 0, pIBB: 0, pHP: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 });
const aggTrain = new Map<string, Agg>();
const aggTest = new Map<string, Agg>();
let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
const dayOf = (fname: string) => { const m = fname.match(/July\s+(\d+)/i); return m ? Number(m[1]) : NaN; };

for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  const day = dayOf(f);
  const target = TRAIN_DAYS.has(day) ? aggTrain : TEST_DAYS.has(day) ? aggTest : null;
  if (!target) { console.log(`  (skipping unmapped day file: ${f})`); continue; }
  const rows = Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as Record<string, unknown>[];
  for (const r of rows) {
    const bf = num(r.BF), pa = num(r.PA);
    if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
    if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
    const key = `${r.CID}|${r.VLvl}`;
    let a = target.get(key);
    if (!a) { a = zeroAgg(r); target.set(key, a); }
    a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.hHP += num(r.HP); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
    a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.pHP += num(r.HP_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
  }
}
// Derived exposure (from all days) — hitters vs RHP, RHP/LHP vs RHB.
const paTot = paR + paL + paS;
const wRhit = bfR / bfAll;
const wRpit: Record<number, number> = { 1: paR / paTot, 2: (paR + paS) / paTot };
console.log(`derived exposure: hitters vs RHP = ${wRhit.toFixed(3)};  RHP vs RHB = ${wRpit[1]!.toFixed(3)}, LHP vs RHB = ${wRpit[2]!.toFixed(3)}`);
console.log(`train-day cards: ${aggTrain.size}   test-day cards: ${aggTest.size}`);

// ── Ratings extraction + exposure-blended TrainObs ──
const ratExtract = (r: Record<string, unknown>) => {
  const R = (s: string, col: string) => num(r[`${col} ${s}`]);
  return {
    hR: { eye: R("vR", "EYE"), pow: R("vR", "POW"), kRat: R("vR", "K"), babip: R("vR", "BA"), gap: R("vR", "GAP") },
    hL: { eye: R("vL", "EYE"), pow: R("vL", "POW"), kRat: R("vL", "K"), babip: R("vL", "BA"), gap: R("vL", "GAP") },
    pR: { con: R("vR", "CON"), stu: R("vR", "STU"), pbabip: R("vR", "PBABIP"), hrr: R("vR", "HRA") },
    pL: { con: R("vL", "CON"), stu: R("vL", "STU"), pbabip: R("vL", "PBABIP"), hrr: R("vL", "HRA") },
  };
};
const blendH = (Rr: any, Ll: any, w: number) => ({ eye: w * Rr.eye + (1 - w) * Ll.eye, pow: w * Rr.pow + (1 - w) * Ll.pow, kRat: w * Rr.kRat + (1 - w) * Ll.kRat, babip: w * Rr.babip + (1 - w) * Ll.babip, gap: w * Rr.gap + (1 - w) * Ll.gap, speed: 0, steal: 0, run: 0 });
const blendP = (Rr: any, Ll: any, w: number) => ({ con: w * Rr.con + (1 - w) * Ll.con, stu: w * Rr.stu + (1 - w) * Ll.stu, pbabip: w * Rr.pbabip + (1 - w) * Ll.pbabip, hrr: w * Rr.hrr + (1 - w) * Ll.hrr });

// Build synthetic TrainObs (hitter & pitcher) from an aggregation, using blended eff ratings.
function makeObs(a: Agg): { hit: TrainObs; pit: TrainObs } {
  const r = a.r; const rx = ratExtract(r);
  const b = bats(String(r.B)), tw = thr(String(r.T));
  const effH = blendH(rx.hR, rx.hL, wRhit);
  const effP = blendP(rx.pR, rx.pL, wRpit[tw]!);
  const hitO = { PA: a.hPA, AB: a.hPA, H: a.h1B + a.h2B + a.h3B + a.hHR, b1: a.h1B, b2: a.h2B, b3: a.h3B, HR: a.hHR, BB: a.hBB, IBB: a.hIBB, HP: a.hHP, SH: 0, SF: 0, K: a.hK, GIDP: 0 };
  const pitO = { BF: a.pBF, IP: 0, AB: a.pBF, b1: a.p1B, b2: a.p2B, b3: a.p3B, HR: a.pHR, BB: a.pBB, IBB: a.pIBB, K: a.pK, HP: a.pHP, SH: 0, SF: 0 };
  const base = { cid: String(r.CID), variant: false, side: "R" as const, name: String(r.Name ?? ""), pos: String(r.POS ?? ""), bats: b, throws: tw, sources: [] };
  return {
    hit: { ...base, key: `${r.CID}|h`, ratings: { hit: effH as any, pitch: effP as any }, hit: hitO, pitch: pitO },
    pit: { ...base, key: `${r.CID}|p`, ratings: { hit: effH as any, pitch: effP as any }, hit: hitO, pitch: pitO },
  };
}

// A card record carrying BOTH the TrainObs (for native predict) and the vR/vL model events
// (for league predict), plus actuals for a given day-set.
const awoba = (bb: number, hp: number, oneB: number, xbh: number, hr: number, denom: number) =>
  denom > 0 ? (W.bb * bb + W.hbp * hp + W.b1 * oneB + W.xbh * xbh + W.hr * hr) / denom : 0;

interface Card {
  cid: string; bats: number; thr: number;
  obsHit: TrainObs; obsPit: TrainObs;             // exposure-blended synthetic obs (ratings constant)
  hitVR: any; hitVL: any; pitVR: any; pitVL: any;  // league raw model events (era-independent)
  vr: { eye: number; pow: number; babip: number; con: number; stu: number; pbabip: number }; // residual axes
}
// Build the card set from a "ratings source" agg (train agg holds representative ratings; but
// ratings are card-constant across days, so either works). We key cards by CID|VLvl.
function buildCard(a: Agg): Card {
  const { hit, pit } = makeObs(a);
  const r = a.r; const rx = ratExtract(r);
  const hRr = { ...rx.hR, speed: 0, steal: 0, run: 0 }, hLr = { ...rx.hL, speed: 0, steal: 0, run: 0 };
  return {
    cid: String(r.CID), bats: bats(String(r.B)), thr: thr(String(r.T)),
    obsHit: hit, obsPit: pit,
    hitVR: rp.predictHitting(hRr as any, coeffs), hitVL: rp.predictHitting(hLr as any, coeffs),
    pitVR: rp.predictPitching(rx.pR as any, coeffs), pitVL: rp.predictPitching(rx.pL as any, coeffs),
    vr: { eye: rx.hR.eye, pow: rx.hR.pow, babip: rx.hR.babip, con: rx.pR.con, stu: rx.pR.stu, pbabip: rx.pR.pbabip },
  };
}

// ── League model prediction (era-1920/park-169 baked into coeffs) — copied from tournament-validate ──
const env = (aHR: number, aBB: number, aGAP = 1): { c: Coeffs; d: Derived } => {
  const c = { ...coeffs, era_bb: coeffs.era_bb * aBB, era_gap: coeffs.era_gap * aGAP } as Coeffs;
  const d = computeDerived(c, true); d.era_effective_hr *= aHR;
  return { c, d };
};
const base = env(1, 1);
const leagueHitWoba = (card: Card) => {
  const one = (e: any, side: "vR" | "vL") => { const k = hittingComponents(e, 1, 1, card.bats, side, base.c, base.d, eventForm); return (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * k.GAP_fin + W.hr * k.HR_fin) / 600; };
  return wRhit * one(card.hitVR, "vR") + (1 - wRhit) * one(card.hitVL, "vL");
};
const leaguePitWoba = (card: Card) => {
  const one = (e: any, side: "vR" | "vL") => { const k = pitchingComponents(e, 1, 1, side, base.c, base.d, eventForm); return (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * k.XBH_fin + W.hr * k.HR_fin) / 600; };
  const w = wRpit[card.thr]!; return w * one(card.pitVR, "vR") + (1 - w) * one(card.pitVL, "vL");
};
// League per-600 event rates (blended) — copied from tournament-validate.
const leagueHitEv = (card: Card): Record<string, number> => {
  const one = (side: "vR" | "vL", e: any) => { const k = hittingComponents(e, 1, 1, card.bats, side, base.c, base.d, eventForm); return { BB: k.BB_fin, K: e.SO * base.c.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; };
  const R = one("vR", card.hitVR), L = one("vL", card.hitVL); const o: Record<string, number> = {};
  for (const k of Object.keys(R)) o[k] = wRhit * (R as any)[k] + (1 - wRhit) * (L as any)[k];
  return o;
};
const leaguePitEv = (card: Card): Record<string, number> => {
  const one = (side: "vR" | "vL", e: any) => { const k = pitchingComponents(e, 1, 1, side, base.c, base.d, eventForm); return { BB: k.BB_fin, K: e.K * base.c.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; };
  const w = wRpit[card.thr]!; const R = one("vR", card.pitVR), L = one("vL", card.pitVL); const o: Record<string, number> = {};
  for (const k of Object.keys(R)) o[k] = w * (R as any)[k] + (1 - w) * (L as any)[k];
  return o;
};

// ── NATIVE model per-600 event rates (reconstruct predictHitForm/predictPitForm internals) ──
const nativeHitEv = (m: any, o: TrainObs): Record<string, number> => {
  const r = o.ratings.hit;
  const bb = rate(m.bb, r.eye), k = rate(m.k, r.kRat), hr = rate(m.hr, r.pow);
  const bip = Math.max(600 - bb - k - hr - HIT_BIP_ADJ, 1);
  const h = hRate(m.h, r.babip, bip);
  const xbh = Math.max(rate(m.xbh, r.gap) * h, 0), oneB = Math.max(h - xbh, 0);
  return { BB: bb, K: k, HR: hr, oneB, XBH: xbh };
};
const nativePitEv = (m: any, o: TrainObs): Record<string, number> => {
  const r = o.ratings.pitch;
  const bb = rateAux(m.bb, r.con, r.stu), k = rate(m.k, r.stu), hr = rateAux(m.hr, r.hrr, r.stu);
  const bip = Math.max(600 - bb - k - hr - PIT_BIP_ADJ, 1);
  const nHH = hRate(m.h, r.pbabip, bip);
  const xbh = nHH * 0.25, oneB = Math.max(nHH - xbh, 0);
  return { BB: bb, K: k, HR: hr, oneB, XBH: xbh };
};

// ── Stats helpers (copied) ──
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

// ── Build cards keyed by CID|VLvl; ratings from train agg (fallback test agg) ──
const cardKeys = new Set<string>([...aggTrain.keys(), ...aggTest.keys()]);
const cards = new Map<string, Card>();
for (const key of cardKeys) {
  const src = aggTrain.get(key) ?? aggTest.get(key)!;
  cards.set(key, buildCard(src));
}

// Actual wOBA + per-600 event rates for a card in a given day-set.
const actHit = (a: Agg) => ({ woba: awoba(a.hBB - a.hIBB, a.hHP, a.h1B, a.h2B + a.h3B, a.hHR, a.hPA), PA: a.hPA,
  ev: a.hPA > 0 ? { BB: a.hBB * 600 / a.hPA, K: a.hK * 600 / a.hPA, HR: a.hHR * 600 / a.hPA, oneB: a.h1B * 600 / a.hPA, XBH: (a.h2B + a.h3B) * 600 / a.hPA } : {} as Record<string, number> });
const actPit = (a: Agg) => ({ woba: awoba(a.pBB - a.pIBB, a.pHP, a.p1B, a.p2B + a.p3B, a.pHR, a.pBF), BF: a.pBF,
  ev: a.pBF > 0 ? { BB: a.pBB * 600 / a.pBF, K: a.pK * 600 / a.pBF, HR: a.pHR * 600 / a.pBF, oneB: a.p1B * 600 / a.pBF, XBH: (a.p2B + a.p3B) * 600 / a.pBF } : {} as Record<string, number> });

// ── Fit the NATIVE model on TRAIN days ──
const trainHitObs: TrainObs[] = [], trainPitObs: TrainObs[] = [];
for (const a of aggTrain.values()) { const { hit, pit } = makeObs(a); if (a.hPA > 0) trainHitObs.push(hit); if (a.pBF > 0) trainPitObs.push(pit); }
console.log(`\nNATIVE fit on TRAIN days: ${trainHitObs.length} hitter obs (PA>0), ${trainPitObs.length} pitcher obs (BF>0)`);
const fitHit = fitHitForm(RAWPOLY_HIT, trainHitObs);
const fitPit = fitPitForm(STUFFAUG_PIT, trainPitObs);

// ── Evaluation harness: for a given day-set agg, evaluate both models at thresholds ──
type EvalRow = { key: string; card: Card; hAgg?: Agg; pAgg?: Agg };
function rowsFrom(agg: Map<string, Agg>): EvalRow[] {
  const out: EvalRow[] = [];
  for (const [key, a] of agg) { const card = cards.get(key)!; out.push({ key, card, hAgg: a.hPA > 0 ? a : undefined, pAgg: a.pBF > 0 ? a : undefined }); }
  return out;
}

function overallTable(label: string, agg: Map<string, Agg>) {
  const rows = rowsFrom(agg);
  console.log(`\n── ${label}: overall wOBA Pearson (PA/BF-weighted) ──`);
  console.log(`  thresh |  Hn  tourn  league |  Pn  tourn  league`);
  for (const th of [250, 500]) {
    const H = rows.filter((r) => r.hAgg && r.hAgg.hPA >= th);
    const P = rows.filter((r) => r.pAgg && r.pAgg.pBF >= th);
    const hT = wpearson(H.map((r) => predictHitForm(fitHit, r.card.obsHit)), H.map((r) => actHit(r.hAgg!).woba), H.map((r) => r.hAgg!.hPA));
    const hL = wpearson(H.map((r) => leagueHitWoba(r.card)), H.map((r) => actHit(r.hAgg!).woba), H.map((r) => r.hAgg!.hPA));
    const pT = wpearson(P.map((r) => predictPitForm(fitPit, r.card.obsPit)), P.map((r) => actPit(r.pAgg!).woba), P.map((r) => r.pAgg!.pBF));
    const pL = wpearson(P.map((r) => leaguePitWoba(r.card)), P.map((r) => actPit(r.pAgg!).woba), P.map((r) => r.pAgg!.pBF));
    console.log(`  ≥${String(th).padEnd(4)} | ${String(H.length).padStart(3)} ${hT.toFixed(3)} ${hL.toFixed(3)} | ${String(P.length).padStart(3)} ${pT.toFixed(3)} ${pL.toFixed(3)}`);
  }
}

function perEventTable(label: string, agg: Map<string, Agg>, th: number) {
  const rows = rowsFrom(agg);
  const evs = ["BB", "K", "HR", "oneB", "XBH"] as const;
  const H = rows.filter((r) => r.hAgg && r.hAgg.hPA >= th);
  const P = rows.filter((r) => r.pAgg && r.pAgg.pBF >= th);
  const evLine = (name: string, recs: EvalRow[], denom: (r: EvalRow) => number, actEv: (r: EvalRow) => Record<string, number>, predT: (r: EvalRow) => Record<string, number>, predL: (r: EvalRow) => Record<string, number>) => {
    const ws = recs.map(denom);
    const t = evs.map((ev) => wpearson(recs.map((r) => predT(r)[ev]!), recs.map((r) => actEv(r)[ev]!), ws).toFixed(2).padStart(5));
    const l = evs.map((ev) => wpearson(recs.map((r) => predL(r)[ev]!), recs.map((r) => actEv(r)[ev]!), ws).toFixed(2).padStart(5));
    console.log(`  ${name} tourn  (n=${String(recs.length).padStart(3)})  BB${t[0]}  K${t[1]}  HR${t[2]}  1B${t[3]}  XBH${t[4]}`);
    console.log(`  ${name} league          BB${l[0]}  K${l[1]}  HR${l[2]}  1B${l[3]}  XBH${l[4]}`);
  };
  console.log(`\n── ${label}: per-EVENT Pearson (predicted vs actual per-600 rate), ≥${th} PA/BF ──`);
  evLine("HIT ", H, (r) => r.hAgg!.hPA, (r) => actHit(r.hAgg!).ev, (r) => nativeHitEv(fitHit, r.card.obsHit), (r) => leagueHitEv(r.card));
  evLine("PIT ", P, (r) => r.pAgg!.pBF, (r) => actPit(r.pAgg!).ev, (r) => nativePitEv(fitPit, r.card.obsPit), (r) => leaguePitEv(r.card));
}

function residTable(label: string, agg: Map<string, Agg>, th: number) {
  const rows = rowsFrom(agg);
  const H = rows.filter((r) => r.hAgg && r.hAgg.hPA >= th);
  const P = rows.filter((r) => r.pAgg && r.pAgg.pBF >= th);
  const hResid = (pred: (r: EvalRow) => number, axis: (c: Card) => number) => residSlope(H.map((r) => ({ pred: pred(r), act: actHit(r.hAgg!).woba, w: r.hAgg!.hPA, rat: axis(r.card) })));
  const pResid = (pred: (r: EvalRow) => number, axis: (c: Card) => number) => residSlope(P.map((r) => ({ pred: pred(r), act: actPit(r.pAgg!).woba, w: r.pAgg!.pBF, rat: axis(r.card) })));
  const tH = (r: EvalRow) => predictHitForm(fitHit, r.card.obsHit), lH = (r: EvalRow) => leagueHitWoba(r.card);
  const tP = (r: EvalRow) => predictPitForm(fitPit, r.card.obsPit), lP = (r: EvalRow) => leaguePitWoba(r.card);
  console.log(`\n── ${label}: residual bias (wOBA pts/SD, want ≈0), ≥${th} PA/BF ──`);
  console.log(`  HITTERS   EYE→BB          POW→HR          BABIP→H`);
  console.log(`    tourn   ${hResid(tH, (c) => c.vr.eye).toFixed(2).padStart(6)}          ${hResid(tH, (c) => c.vr.pow).toFixed(2).padStart(6)}          ${hResid(tH, (c) => c.vr.babip).toFixed(2).padStart(6)}`);
  console.log(`    league  ${hResid(lH, (c) => c.vr.eye).toFixed(2).padStart(6)}          ${hResid(lH, (c) => c.vr.pow).toFixed(2).padStart(6)}          ${hResid(lH, (c) => c.vr.babip).toFixed(2).padStart(6)}`);
  console.log(`  PITCHERS  CON→BB          STU→K           pBABIP→H`);
  console.log(`    tourn   ${pResid(tP, (c) => c.vr.con).toFixed(2).padStart(6)}          ${pResid(tP, (c) => c.vr.stu).toFixed(2).padStart(6)}          ${pResid(tP, (c) => c.vr.pbabip).toFixed(2).padStart(6)}`);
  console.log(`    league  ${pResid(lP, (c) => c.vr.con).toFixed(2).padStart(6)}          ${pResid(lP, (c) => c.vr.stu).toFixed(2).padStart(6)}          ${pResid(lP, (c) => c.vr.pbabip).toFixed(2).padStart(6)}`);
}

// ── TEST DAYS (hold-out) — the headline comparison ──
console.log(`\n############ TEST DAYS (July 10-11, true out-of-sample) ############`);
overallTable("TEST", aggTest);
perEventTable("TEST", aggTest, 250);
perEventTable("TEST", aggTest, 500);
residTable("TEST", aggTest, 500);

// ── TRAIN DAYS (in-sample context) ──
console.log(`\n############ TRAIN DAYS (July 5-9, in-sample) ############`);
overallTable("TRAIN", aggTrain);
perEventTable("TRAIN", aggTrain, 500);

process.exit(0);
