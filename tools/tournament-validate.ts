// Validate the LEAGUE model against real tournament outcomes (Early Gold, era-1920 dead-ball,
// park-169), and fit the per-tournament era ADJUSTMENT (HR/BB modifiers) to the actuals.
//   1) exposure blend derived FROM the data (RHP share thrown / RHB share faced), not assumed
//   2) counts + correlations at PA/BF thresholds (100/250/500/750/1000) — noise falls with volume
//   3) the era-adjustment (hr,bb): none vs the shipped default (1.15/0.85) vs a grid-fit best,
//      reporting correlation AND the residual-bias slopes it flattens.
//
//   run: node tools/tournament-validate.ts

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, computeUnifiedFieldStats, buildPoolTransform, applyAffine, type Coeffs, type Derived, type PoolTransform } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TID = process.argv[2] ?? "early-gold";
const TDIR = process.argv[3] ?? "Tournament Data/Early Gold";
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
console.log(`\n=== League model vs ${t.name} actuals — env era ${t.eraId} / park ${t.parkId}, model ${state.activeModelId} ===`);

// ── Pool-strength transform (deployed component; toggle with PT=0) — re-bases ratings toward the
// reference field, per role×side, exactly like the server (ref = full base catalog top-50; pool =
// the tournament's eligible base subset top-50; capped at the model's rating envelope). ──
const usePT = process.env.PT !== "0";
let pt: PoolTransform | undefined;
if (usePT) {
  const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
  const isBase = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
  const inVal = (c: any) => { const v = num(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const fullBase = cat.cards.filter(isBase);
  const eligBase = cat.cards.filter((c) => isBase(c) && inVal(c) && rowEligible(c as any, t));
  const ref = computeUnifiedFieldStats(fullBase, coeffs, rp, 50, true);
  const pool = computeUnifiedFieldStats(eligBase, coeffs, rp, 50, true);
  pt = buildPoolTransform(ref, pool, trained?.ratingEnvelope ?? undefined);
  console.log(`pool transform ON: ref ${fullBase.length} base / pool ${eligBase.length} eligible base cards`);
} else console.log(`pool transform OFF`);
// apply the transform to a card's raw ratings (identity when off)
const txH = (s: "vR" | "vL", o: any) => (pt ? { eye: applyAffine(o.eye, (pt.hit as any)[s].eye), pow: applyAffine(o.pow, (pt.hit as any)[s].pow), kRat: applyAffine(o.kRat, (pt.hit as any)[s].kRat), babip: applyAffine(o.babip, (pt.hit as any)[s].babip), gap: applyAffine(o.gap, (pt.hit as any)[s].gap), speed: 0, steal: 0, run: 0 } : o);
const txP = (s: "vR" | "vL", o: any) => (pt ? { con: applyAffine(o.con, (pt.pit as any)[s].con), stu: applyAffine(o.stu, (pt.pit as any)[s].stu), pbabip: applyAffine(o.pbabip, (pt.pit as any)[s].pbabip), hrr: applyAffine(o.hrr, (pt.pit as any)[s].hrr) } : o);

// ── Aggregate per (CID, VLvl) across all 7 daily files; also tally field handedness ──
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3);
const thr = (x: string) => (x === "R" ? 1 : 2);
interface Agg { r: Record<string, unknown>; hPA: number; hBB: number; hIBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number;
  pBF: number; pBB: number; pIBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
const agg = new Map<string, Agg>();
let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0; // field handedness tallies
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  const rows = Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as Record<string, unknown>[];
  for (const r of rows) {
    const bf = num(r.BF), pa = num(r.PA);
    if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
    if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
    const key = `${r.CID}|${r.VLvl}`;
    let a = agg.get(key);
    if (!a) { a = { r, hPA: 0, hBB: 0, hIBB: 0, hHP: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, pBF: 0, pBB: 0, pIBB: 0, pHP: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 }; agg.set(key, a); }
    a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.hHP += num(r.HP); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
    a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.pHP += num(r.HP_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
  }
}
// Derived exposure: hitters face RHP `wRhit` of the time; a RHP faces RHB `wRpit[R]`, a LHP `wRpit[L]`
// (switch hitters flip: they bat L vs RHP, R vs LHP).
const paTot = paR + paL + paS;
const wRhit = bfR / bfAll;
const wRpit: Record<number, number> = { 1: paR / paTot, 2: (paR + paS) / paTot };
console.log(`derived exposure: hitters vs RHP = ${wRhit.toFixed(3)} (was assuming 0.62);  RHP vs RHB = ${wRpit[1]!.toFixed(3)}, LHP vs RHB = ${wRpit[2]!.toFixed(3)} (was assuming 0.50)`);
console.log(`field: RHP throws ${(bfR / bfAll * 100).toFixed(1)}% of BF; batters R/L/S = ${(paR / paTot * 100).toFixed(0)}/${(paL / paTot * 100).toFixed(0)}/${(paS / paTot * 100).toFixed(0)}%`);

// ── Per card: raw model events (era-independent), actuals, ratings for residual axes ──
const awoba = (bb: number, hp: number, oneB: number, xbh: number, hr: number, denom: number) =>
  denom > 0 ? (W.bb * bb + W.hbp * hp + W.b1 * oneB + W.xbh * xbh + W.hr * hr) / denom : 0;
interface Card { hitVR: any; hitVL: any; pitVR: any; pitVL: any; bats: number; thr: number;
  hPA: number; pBF: number; hAct: number; pAct: number; stu: number; con: number; eye: number; pow: number;
  kRat: number; babip: number; gap: number; hra: number; pbabip: number;
  hEv: Record<string, number>; pEv: Record<string, number> } // actual per-600 event rates
const cards: Card[] = [];
for (const a of agg.values()) {
  const r = a.r;
  const R = (s: string, col: string) => num(r[`${col} ${s}`]);
  const hR = { eye: R("vR", "EYE"), pow: R("vR", "POW"), kRat: R("vR", "K"), babip: R("vR", "BA"), gap: R("vR", "GAP"), speed: 0, steal: 0, run: 0 };
  const hL = { eye: R("vL", "EYE"), pow: R("vL", "POW"), kRat: R("vL", "K"), babip: R("vL", "BA"), gap: R("vL", "GAP"), speed: 0, steal: 0, run: 0 };
  const pR = { con: R("vR", "CON"), stu: R("vR", "STU"), pbabip: R("vR", "PBABIP"), hrr: R("vR", "HRA") };
  const pL = { con: R("vL", "CON"), stu: R("vL", "STU"), pbabip: R("vL", "PBABIP"), hrr: R("vL", "HRA") };
  cards.push({
    hitVR: rp.predictHitting(txH("vR", hR), coeffs), hitVL: rp.predictHitting(txH("vL", hL), coeffs),
    pitVR: rp.predictPitching(txP("vR", pR), coeffs), pitVL: rp.predictPitching(txP("vL", pL), coeffs),
    bats: bats(String(r.B)), thr: thr(String(r.T)),
    hPA: a.hPA, pBF: a.pBF,
    hAct: awoba(a.hBB - a.hIBB, a.hHP, a.h1B, a.h2B + a.h3B, a.hHR, a.hPA),
    pAct: awoba(a.pBB - a.pIBB, a.pHP, a.p1B, a.p2B + a.p3B, a.pHR, a.pBF),
    stu: R("vR", "STU"), con: R("vR", "CON"), eye: R("vR", "EYE"), pow: R("vR", "POW"),
    kRat: R("vR", "K"), babip: R("vR", "BA"), gap: R("vR", "GAP"), hra: R("vR", "HRA"), pbabip: R("vR", "PBABIP"),
    hEv: a.hPA > 0 ? { BB: a.hBB * 600 / a.hPA, K: a.hK * 600 / a.hPA, HR: a.hHR * 600 / a.hPA, oneB: a.h1B * 600 / a.hPA, XBH: (a.h2B + a.h3B) * 600 / a.hPA } : {},
    pEv: a.pBF > 0 ? { BB: a.pBB * 600 / a.pBF, K: a.pK * 600 / a.pBF, HR: a.pHR * 600 / a.pBF, oneB: a.p1B * 600 / a.pBF, XBH: (a.p2B + a.p3B) * 600 / a.pBF } : {},
  });
}

// Assemble a trusted per-600 wOBA from raw events under an adjusted environment (hr,bb,gap modifiers).
const env = (aHR: number, aBB: number, aGAP = 1): { c: Coeffs; d: Derived } => {
  const c = { ...coeffs, era_bb: coeffs.era_bb * aBB, era_gap: coeffs.era_gap * aGAP } as Coeffs;
  const d = computeDerived(c, true); d.era_effective_hr *= aHR;
  return { c, d };
};
const hitPred = (card: Card, c: Coeffs, d: Derived) => {
  const one = (e: any, side: "vR" | "vL") => { const k = hittingComponents(e, 1, 1, card.bats, side, c, d, eventForm); return (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * k.GAP_fin + W.hr * k.HR_fin) / 600; };
  return wRhit * one(card.hitVR, "vR") + (1 - wRhit) * one(card.hitVL, "vL");
};
const pitPred = (card: Card, c: Coeffs, d: Derived) => {
  const one = (e: any, side: "vR" | "vL") => { const k = pitchingComponents(e, 1, 1, side, c, d, eventForm); return (W.bb * k.BB_fin + W.hbp * HBP + W.b1 * k.oneB_fin + W.xbh * k.XBH_fin + W.hr * k.HR_fin) / 600; };
  const w = wRpit[card.thr]!; return w * one(card.pitVR, "vR") + (1 - w) * one(card.pitVL, "vL");
};

// ── Stats helpers ──
const wmean = (xs: number[], ws: number[]) => xs.reduce((s, x, i) => s + x * ws[i]!, 0) / ws.reduce((s, x) => s + x, 0);
const wpearson = (xs: number[], ys: number[], ws: number[]) => { const mx = wmean(xs, ws), my = wmean(ys, ws); let a = 0, b = 0, c = 0; for (let i = 0; i < xs.length; i++) { const w = ws[i]!, dx = xs[i]! - mx, dy = ys[i]! - my; a += w * dx * dy; b += w * dx * dx; c += w * dy * dy; } return a / Math.sqrt(b * c); };
const spearman = (xs: number[], ys: number[]) => { const rk = (a: number[]) => { const o = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k + 1)); return r as number[]; }; const rx = rk(xs), ry = rk(ys), n = xs.length, m = (n + 1) / 2; let c = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const dx = rx[i]! - m, dy = ry[i]! - m; c += dx * dy; sx += dx * dx; sy += dy * dy; } return c / Math.sqrt(sx * sy); };
// residual bias: actual minus affine-aligned predicted, slope on a standardized rating (wOBA pts/SD)
const residSlope = (recs: { pred: number; act: number; w: number; rat: number }[]) => {
  const xs = recs.map((r) => r.pred), ys = recs.map((r) => r.act), ws = recs.map((r) => r.w);
  const mx = wmean(xs, ws), my = wmean(ys, ws); let cxy = 0, cxx = 0; for (let i = 0; i < xs.length; i++) { cxy += ws[i]! * (xs[i]! - mx) * (ys[i]! - my); cxx += ws[i]! * (xs[i]! - mx) ** 2; }
  const b = cxy / cxx, a0 = my - b * mx; const res = recs.map((r) => r.act - (a0 + b * r.pred));
  const rv = recs.map((r) => r.rat), mr = wmean(rv, ws), sd = Math.sqrt(wmean(rv.map((v) => (v - mr) ** 2), ws)) || 1;
  const z = rv.map((v) => (v - mr) / sd); const mres = wmean(res, ws); let cz = 0, zz = 0;
  for (let i = 0; i < res.length; i++) { cz += ws[i]! * z[i]! * (res[i]! - mres); zz += ws[i]! * z[i]! ** 2; }
  return (cz / zz) * 1000;
};

// ── Part 2: threshold distribution + correlation (no adjustment) ──
const base = env(1, 1);
console.log(`\n── threshold distribution + correlation (no era-adjustment, derived exposure) ──`);
console.log(`  thresh   Hn  Pearson Spearman |  Pn  Pearson Spearman`);
for (const th of [100, 250, 500, 750, 1000]) {
  const h = cards.filter((c) => c.hPA >= th), p = cards.filter((c) => c.pBF >= th);
  const hp = wpearson(h.map((c) => hitPred(c, base.c, base.d)), h.map((c) => c.hAct), h.map((c) => c.hPA));
  const hs = spearman(h.map((c) => hitPred(c, base.c, base.d)), h.map((c) => c.hAct));
  const pp = wpearson(p.map((c) => pitPred(c, base.c, base.d)), p.map((c) => c.pAct), p.map((c) => c.pBF));
  const ps = spearman(p.map((c) => pitPred(c, base.c, base.d)), p.map((c) => c.pAct));
  console.log(`  ≥${String(th).padEnd(5)} ${String(h.length).padStart(4)} ${hp.toFixed(3).padStart(7)} ${hs.toFixed(3).padStart(8)} | ${String(p.length).padStart(3)} ${pp.toFixed(3).padStart(7)} ${ps.toFixed(3).padStart(8)}`);
}

// ── Part 3: era-adjustment (hr,bb,gap) — none vs default vs grid-fit. Fit on ≥500 PA/BF (clean) ──
const FIT = 500;
const H = cards.filter((c) => c.hPA >= FIT), P = cards.filter((c) => c.pBF >= FIT);

// ── Per-EVENT accuracy @ no-adjustment: how well does the model predict each event RATE (not wOBA)? ──
// Predicted era-1920 event rates (per 600), blended vR/vL at the derived exposure, vs actuals.
{
  const b0 = env(1, 1);
  const hEvPred = (card: Card, side: "vR" | "vL", e: any) => { const k = hittingComponents(e, 1, 1, card.bats, side, b0.c, b0.d, eventForm); return { BB: k.BB_fin, K: e.SO * b0.c.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; };
  const pEvPred = (card: Card, side: "vR" | "vL", e: any) => { const k = pitchingComponents(e, 1, 1, side, b0.c, b0.d, eventForm); return { BB: k.BB_fin, K: e.K * b0.c.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; };
  const blend = (R: any, L: any, w: number) => { const o: Record<string, number> = {}; for (const k of Object.keys(R)) o[k] = w * R[k] + (1 - w) * L[k]; return o; };
  const evs = ["BB", "K", "HR", "oneB", "XBH"];
  const line = (name: string, recs: Card[], predOf: (c: Card) => Record<string, number>, actKey: "hEv" | "pEv", th: number) => {
    const cs = recs.filter((c) => (actKey === "hEv" ? c.hPA : c.pBF) >= th);
    const ws = cs.map((c) => (actKey === "hEv" ? c.hPA : c.pBF));
    const out = evs.map((ev) => wpearson(cs.map((c) => predOf(c)[ev]!), cs.map((c) => c[actKey][ev]!), ws).toFixed(2).padStart(5));
    console.log(`  ${name.padEnd(9)} (n=${String(cs.length).padStart(3)})  BB ${out[0]}  K ${out[1]}  HR ${out[2]}  1B ${out[3]}  XBH ${out[4]}`);
  };
  console.log(`\n── per-EVENT accuracy @ no-adjustment, ≥${FIT} PA/BF (Pearson of predicted vs actual event RATE) ──`);
  line("HITTERS", cards, (c) => blend(hEvPred(c, "vR", c.hitVR), hEvPred(c, "vL", c.hitVL), wRhit), "hEv", FIT);
  line("PITCHERS", cards, (c) => blend(pEvPred(c, "vR", c.pitVR), pEvPred(c, "vL", c.pitVL), wRpit[c.thr]!), "pEv", FIT);
  console.log(`  (a high per-event Pearson with a biased wOBA ⇒ the RATES are right but the WEIGHTS/values are wrong`);
  console.log(`   for this env — Theory 1. A LOW per-event Pearson ⇒ that event's curve/era-factor is the miss.)`);
}

// ── Full residual-bias scan across EVERY rating axis @ no-adjustment — which era FACTORS are off? ──
{
  const b0 = env(1, 1);
  const hb = (g: (x: Card) => number) => residSlope(H.map((x) => ({ pred: hitPred(x, b0.c, b0.d), act: x.hAct, w: x.hPA, rat: g(x) })));
  const pb = (g: (x: Card) => number) => residSlope(P.map((x) => ({ pred: pitPred(x, b0.c, b0.d), act: x.pAct, w: x.pBF, rat: g(x) })));
  console.log(`\n── full bias scan @ no-adjustment, ≥${FIT} PA/BF (residual wOBA pts/SD, want ≈0 — maps to the FACTOR that fixes it) ──`);
  console.log(`  HITTERS   EYE→BB ${hb((x) => x.eye).toFixed(2).padStart(6)}  POW→HR ${hb((x) => x.pow).toFixed(2).padStart(6)}  AvoidK→K ${hb((x) => x.kRat).toFixed(2).padStart(6)}  BABIP→H ${hb((x) => x.babip).toFixed(2).padStart(6)}  GAP→GAP ${hb((x) => x.gap).toFixed(2).padStart(6)}`);
  console.log(`  PITCHERS  CON→BB ${pb((x) => x.con).toFixed(2).padStart(6)}  HRA→HR ${pb((x) => x.hra).toFixed(2).padStart(6)}  STU→K   ${pb((x) => x.stu).toFixed(2).padStart(6)}  pBABIP→H ${pb((x) => x.pbabip).toFixed(2).padStart(5)}`);
  console.log(`  (hitters: + = model UNDER-rates it / it out-performs. pitchers (allowed): + = model OVER-rates it / it`);
  console.log(`   allows more than predicted. Large |slope| ⇒ that factor is NOT correct at 1 for Early Gold.)`);
}

const evalAdj = (aHR: number, aBB: number, aGAP = 1) => {
  const { c, d } = env(aHR, aBB, aGAP);
  const hp = H.map((x) => ({ pred: hitPred(x, c, d), act: x.hAct, w: x.hPA }));
  const pp = P.map((x) => ({ pred: pitPred(x, c, d), act: x.pAct, w: x.pBF }));
  const slPOW = residSlope(H.map((x, i) => ({ ...hp[i]!, rat: x.pow })));
  const slEYE = residSlope(H.map((x, i) => ({ ...hp[i]!, rat: x.eye })));
  const slSTU = residSlope(P.map((x, i) => ({ ...pp[i]!, rat: x.stu })));
  const slCON = residSlope(P.map((x, i) => ({ ...pp[i]!, rat: x.con })));
  const hP = wpearson(hp.map((r) => r.pred), hp.map((r) => r.act), hp.map((r) => r.w));
  const pP = wpearson(pp.map((r) => r.pred), pp.map((r) => r.act), pp.map((r) => r.w));
  return { aHR, aBB, aGAP, hP, pP, slPOW, slEYE, slSTU, slCON, biasSq: slPOW ** 2 + slEYE ** 2 + slSTU ** 2 + slCON ** 2 };
};
const show = (label: string, r: ReturnType<typeof evalAdj>) =>
  console.log(`  ${label.padEnd(24)} HR×${r.aHR.toFixed(2)} BB×${r.aBB.toFixed(2)} GAP×${r.aGAP.toFixed(2)} | hitP ${r.hP.toFixed(3)} pitP ${r.pP.toFixed(3)} | resid POW ${r.slPOW.toFixed(2)} EYE ${r.slEYE.toFixed(2)} STU ${r.slSTU.toFixed(2)} CON ${r.slCON.toFixed(2)}`);
console.log(`\n── era-adjustment fit (on ≥${FIT} PA/BF: ${H.length} hitters / ${P.length} pitchers; residual = wOBA pts/SD, want ≈0) ──`);
show("none", evalAdj(1, 1));
show("shipped default", evalAdj(1.15, 0.85));
// grid over HR, BB, GAP
const gridBest = (score: (r: ReturnType<typeof evalAdj>) => number) => {
  let b: ReturnType<typeof evalAdj> | null = null;
  for (let hr = 1.0; hr <= 2.8001; hr += 0.2) for (let bb = 0.35; bb <= 1.0001; bb += 0.05) for (let gp = 1.0; gp <= 3.0001; gp += 0.25) {
    const r = evalAdj(hr, bb, gp); if (!b || score(r) < score(b)) b = r;
  }
  return b!;
};
show("bias-min (HR+BB+GAP)", gridBest((r) => r.biasSq));
show("corr-max (HR+BB+GAP)", gridBest((r) => -(r.hP + r.pP)));
// HR vs GAP as the POWER lever: best with GAP pinned to 1 (HR does it) vs HR pinned to 1 (GAP does it)
const pin = (fixHR: number | null, fixGAP: number | null) => {
  let b: ReturnType<typeof evalAdj> | null = null;
  for (let hr = 1.0; hr <= 2.8001; hr += 0.2) for (let bb = 0.35; bb <= 1.0001; bb += 0.05) for (let gp = 1.0; gp <= 3.0001; gp += 0.25) {
    if (fixHR != null && Math.abs(hr - fixHR) > 1e-9) continue; if (fixGAP != null && Math.abs(gp - fixGAP) > 1e-9) continue;
    const r = evalAdj(hr, bb, gp); if (!b || r.biasSq < b.biasSq) b = r;
  }
  return b!;
};
// ── HR factor sweep: what single HR value is actually best? (GAP=1; at BB=1.0 and at BB=0.35) ──
console.log(`\n── HR-factor sweep — is there a best value? (GAP=1) ──`);
for (const bb of [1.0, 0.35]) {
  console.log(`  at BB×${bb.toFixed(2)}:   HR    hitP   pitP   POWresid  CONresid`);
  for (const hr of [1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0]) {
    const r = evalAdj(hr, bb, 1);
    console.log(`               ${hr.toFixed(2).padStart(6)} ${r.hP.toFixed(3)} ${r.pP.toFixed(3)}   ${r.slPOW.toFixed(2).padStart(6)}   ${r.slCON.toFixed(2).padStart(6)}`);
  }
}
console.log(`\n  Read: if pitP/hitP FALL as HR rises while POW/CON only flatten, there is NO good single HR value —`);
console.log(`  the tension is inherent (blunt multiplier on a rare, noisy event). If corr holds flat while the`);
console.log(`  residuals flatten, the peak-corr HR IS the better factor. K/H held at 1.`);
process.exit(0);
