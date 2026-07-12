// Proper eval: NATIVE tournament model (5-fold CV BY CARD) vs LEAGUE model (era-1920/park-169,
// NO adjustment), on the FULL 7-day actuals at >=500 PA/BF (stable targets). Reports Spearman,
// Pearson, and top-26 overlap for each event and wOBA. Same deployed wOBA weights for everything.
//
//   run: node tools/tournament-cv.ts

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, computeUnifiedFieldStats, buildPoolTransform, applyAffine, type PoolTransform } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../src/training/forms.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TDIR = process.env.TD ?? "Tournament Data/Early Gold";
const TID = process.env.TID ?? "early-gold";
const TH = Number(process.env.TH ?? 500), K = 5;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3), thr = (x: string) => (x === "R" ? 1 : 2);
const fold = (cid: string) => { let h = 2166136261; for (let i = 0; i < cid.length; i++) { h ^= cid.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % K; };

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
const rpLeague = makeRawPolyModel(eventForm);

interface Agg { r: any; cid: string; hPA: number; hBB: number; hIBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number;
  pBF: number; pBB: number; pIBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
const m = new Map<string, Agg>();
let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
    const pa = num(r.PA), bf = num(r.BF);
    if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
    if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
    const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
    if (!a) { a = { r, cid: String(r.CID), hPA: 0, hBB: 0, hIBB: 0, hHP: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, pBF: 0, pBB: 0, pIBB: 0, pHP: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 }; m.set(key, a); }
    a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.hHP += num(r.HP); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
    a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.pHP += num(r.HP_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
  }
}
const wRhit = bfR / bfAll, wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const hRat = (r: any, s: string) => ({ eye: R(r, s, "EYE"), pow: R(r, s, "POW"), kRat: R(r, s, "K"), babip: R(r, s, "BA"), gap: R(r, s, "GAP"), speed: 0, steal: 0, run: 0 });
const pRat = (r: any, s: string) => ({ con: R(r, s, "CON"), stu: R(r, s, "STU"), pbabip: R(r, s, "PBABIP"), hrr: R(r, s, "HRA") });
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
const blH = (r: any) => { const A = hRat(r, "vR"), B = hRat(r, "vL"), o: any = { speed: 0, steal: 0, run: 0 }; for (const k of ["eye", "pow", "kRat", "babip", "gap"]) o[k] = bl((A as any)[k], (B as any)[k], wRhit); return o; };
const blP = (r: any, tn: number) => { const A = pRat(r, "vR"), B = pRat(r, "vL"), o: any = {}; for (const k of ["con", "stu", "pbabip", "hrr"]) o[k] = bl((A as any)[k], (B as any)[k], wRpit[tn]!); return o; };
const asm = (e: any) => (W.bb * e.BB + W.hbp * HBP + W.b1 * e.oneB + W.xbh * e.XBH + W.hr * e.HR) / 600;

const cards = [...m.values()];
const mkHitObs = (a: Agg) => ({ ratings: { hit: blH(a.r), pitch: pRat(a.r, "vR") }, hit: { PA: a.hPA, BB: a.hBB, K: a.hK, HR: a.hHR, H: a.h1B + a.h2B + a.h3B + a.hHR, b2: a.h2B, b3: a.h3B }, pitch: { BF: 0 } });
const mkPitObs = (a: Agg) => ({ ratings: { hit: hRat(a.r, "vR"), pitch: blP(a.r, thr(String(a.r.T))) }, pitch: { BF: a.pBF, BB: a.pBB, K: a.pK, HR: a.pHR, b1: a.p1B, b2: a.p2B, b3: a.p3B }, hit: { PA: 0 } });

// CV predictions for the native model (fit on other folds, predict this fold)
const tourHitPred = new Map<Agg, any>(), tourPitPred = new Map<Agg, any>();
for (let f = 0; f < K; f++) {
  const trH = cards.filter((a) => a.hPA > 0 && fold(a.cid) !== f).map(mkHitObs);
  const trP = cards.filter((a) => a.pBF > 0 && fold(a.cid) !== f).map(mkPitObs);
  const fm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, trH as any), pit: fitPitForm(STUFFAUG_PIT, trP as any) };
  const rp = makeRawPolyModel(fm);
  for (const a of cards) if (fold(a.cid) === f) {
    if (a.hPA > 0) { const e = rp.predictHitting(blH(a.r), coeffs); tourHitPred.set(a, { BB: e.BB, K: e.SO, HR: e.HR, oneB: e.oneB, XBH: e.GAP }); }
    if (a.pBF > 0) { const e = rp.predictPitching(blP(a.r, thr(String(a.r.T))), coeffs); tourPitPred.set(a, { BB: e.BB, K: e.K, HR: e.HR, oneB: e.nHH - e.XBH, XBH: e.XBH }); }
  }
}
// Pool transform for the LEAGUE model only (re-bases foreign ratings toward the reference field).
// Native (in-frame) is NOT transformed. Toggle with PT=0.
let pt: PoolTransform | undefined;
if (process.env.PT !== "0") {
  const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
  const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const refF = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rpLeague, 50, true);
  const poolF = computeUnifiedFieldStats(cat.cards.filter((c) => isB(c) && inV(c) && rowEligible(c as any, t)), coeffs, rpLeague, 50, true);
  pt = buildPoolTransform(refF, poolF, trained.ratingEnvelope ?? undefined);
  console.log(`(league model uses pool transform ON)`);
}
// PTMODE=opp → additive opponent-gap lifts (matchup channels: eye↔con, kRat↔stu, pow↔hrr,
// babip/gap↔pbabip) instead of the production own-gap faded mean-scalar.
let OG: any = null;
if (process.env.PT !== "0" && process.env.PTMODE === "opp") {
  const cat2 = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
  const isB2 = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
  const inV2 = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const refF2 = computeUnifiedFieldStats(cat2.cards.filter(isB2), coeffs, rpLeague, 50, true);
  const poolF2 = computeUnifiedFieldStats(cat2.cards.filter((c) => isB2(c) && inV2(c) && rowEligible(c as any, t)), coeffs, rpLeague, 50, true);
  const gp = (role: "hit" | "pit", k: string) => (refF2 as any)[role].vR[k].mu - (poolF2 as any)[role].vR[k].mu;
  OG = { hit: { eye: gp("pit", "con"), kRat: gp("pit", "stu"), pow: gp("pit", "hrr"), babip: gp("pit", "pbabip"), gap: gp("pit", "pbabip") },
         pit: { con: gp("hit", "eye"), stu: gp("hit", "kRat"), hrr: gp("hit", "pow"), pbabip: gp("hit", "babip") } };
  pt = undefined;
  console.log(`(league model uses OPPONENT-GAP transform)`);
}
const txH = (s: "vR" | "vL", o: any) => OG ? { eye: o.eye + OG.hit.eye, pow: o.pow + OG.hit.pow, kRat: o.kRat + OG.hit.kRat, babip: o.babip + OG.hit.babip, gap: o.gap + OG.hit.gap, speed: 0, steal: 0, run: 0 }
  : pt ? { eye: applyAffine(o.eye, (pt.hit as any)[s].eye), pow: applyAffine(o.pow, (pt.hit as any)[s].pow), kRat: applyAffine(o.kRat, (pt.hit as any)[s].kRat), babip: applyAffine(o.babip, (pt.hit as any)[s].babip), gap: applyAffine(o.gap, (pt.hit as any)[s].gap), speed: 0, steal: 0, run: 0 } : o;
const txP = (s: "vR" | "vL", o: any) => OG ? { con: o.con + OG.pit.con, stu: o.stu + OG.pit.stu, pbabip: o.pbabip + OG.pit.pbabip, hrr: o.hrr + OG.pit.hrr }
  : pt ? { con: applyAffine(o.con, (pt.pit as any)[s].con), stu: applyAffine(o.stu, (pt.pit as any)[s].stu), pbabip: applyAffine(o.pbabip, (pt.pit as any)[s].pbabip), hrr: applyAffine(o.hrr, (pt.pit as any)[s].hrr) } : o;
const leagueHit = (r: any) => { const side = (s: "vR" | "vL") => { const e = rpLeague.predictHitting(txH(s, hRat(r, s)), coeffs); const k = hittingComponents(e, 1, 1, bats(String(r.B)), s, coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.SO * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; }; const A = side("vR"), B = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "oneB", "XBH"]) o[k] = bl((A as any)[k], (B as any)[k], wRhit); return o; };
const leaguePit = (r: any) => { const w = wRpit[thr(String(r.T))]!; const side = (s: "vR" | "vL") => { const e = rpLeague.predictPitching(txP(s, pRat(r, s)), coeffs); const k = pitchingComponents(e, 1, 1, s, coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.K * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; }; const A = side("vR"), B = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "oneB", "XBH"]) o[k] = bl((A as any)[k], (B as any)[k], w); return o; };

const wp = (x: number[], y: number[], w: number[]) => { const mn = (a: number[]) => a.reduce((s, v, i) => s + v * w[i]!, 0) / w.reduce((s, v) => s + v, 0); const mx = mn(x), my = mn(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { const dw = w[i]!, dx = x[i]! - mx, dy = y[i]! - my; a += dw * dx * dy; b += dw * dx * dx; c += dw * dy * dy; } return a / Math.sqrt(b * c); };
const sp = (x: number[], y: number[]) => { const rk = (a: number[]) => { const o = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k + 1)); return r as number[]; }; const rx = rk(x), ry = rk(y), n = x.length, mm = (n + 1) / 2; let c = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const dx = rx[i]! - mm, dy = ry[i]! - mm; c += dx * dy; sx += dx * dx; sy += dy * dy; } return c / Math.sqrt(sx * sy); };
const top = (v: number[], n: number, best: "hi" | "lo") => new Set(v.map((x, i) => [x, i] as [number, number]).sort((a, b) => best === "hi" ? b[0] - a[0] : a[0] - b[0]).slice(0, n).map((p) => p[1]));
const EV = ["BB", "K", "HR", "oneB", "XBH"], LBL: any = { BB: "BB", K: "K", HR: "HR", oneB: "1B", XBH: "XBH" };

function report(role: "hit" | "pit") {
  const cs = cards.filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
  const w = cs.map((a) => (role === "hit" ? a.hPA : a.pBF));
  const g = (a: Agg, n: number) => n * 600 / (role === "hit" ? a.hPA : a.pBF);
  const actEv = (a: Agg, ev: string) => role === "hit" ? ({ BB: g(a, a.hBB), K: g(a, a.hK), HR: g(a, a.hHR), oneB: g(a, a.h1B), XBH: g(a, a.h2B + a.h3B) } as any)[ev] : ({ BB: g(a, a.pBB), K: g(a, a.pK), HR: g(a, a.pHR), oneB: g(a, a.p1B), XBH: g(a, a.p2B + a.p3B) } as any)[ev];
  const actW = cs.map((a) => role === "hit" ? asm({ BB: g(a, a.hBB - a.hIBB), oneB: g(a, a.h1B), XBH: g(a, a.h2B + a.h3B), HR: g(a, a.hHR) }) : asm({ BB: g(a, a.pBB - a.pIBB), oneB: g(a, a.p1B), XBH: g(a, a.p2B + a.p3B), HR: g(a, a.pHR) }));
  const preds: [string, Map<Agg, any> | ((r: any) => any)][] = role === "hit" ? [["League", leagueHit], ["Tournament (CV)", tourHitPred]] : [["League", leaguePit], ["Tournament (CV)", tourPitPred]];
  const actE: any = {}; for (const ev of EV) actE[ev] = cs.map((a) => actEv(a, ev));
  const best = role === "hit" ? "hi" : "lo"; const actTop = top(actW, 26, best);
  console.log(`\n===== ${role === "hit" ? "HITTERS" : "PITCHERS"} — full 7-day actuals, >=${TH} ${role === "hit" ? "PA" : "BF"} (n=${cs.length}); native = ${K}-fold CV by card =====`);
  for (const metric of ["Spearman", "Pearson"] as const) {
    console.log(`  ${metric.padEnd(9)} ${EV.map((e) => LBL[e].padStart(6)).join("")}${"wOBA".padStart(7)}${"top26".padStart(7)}`);
    for (const [name, P] of preds) {
      const pv = (a: Agg) => typeof P === "function" ? P(a.r) : P.get(a);
      const cells = EV.map((ev) => (metric === "Spearman" ? sp(cs.map((a) => pv(a)[ev]), actE[ev]) : wp(cs.map((a) => pv(a)[ev]), actE[ev], w)).toFixed(2).padStart(6));
      const pw = cs.map((a) => asm(pv(a)));
      const wc = (metric === "Spearman" ? sp(pw, actW) : wp(pw, actW, w)).toFixed(2).padStart(7);
      const ov = metric === "Spearman" ? `${[...top(pw, 26, best)].filter((i) => actTop.has(i)).length}/26`.padStart(7) : "".padStart(7);
      console.log(`    ${name.padEnd(16)}${cells.join("")}${wc}${ov}`);
    }
  }
}
report("hit"); report("pit");
console.log(`\n(HR in era-1920 is ×0.25 — genuinely rare, so HR/wOBA corr is capped by outcome noise even at ${TH}. top26 = overlap of predicted vs actual best-26 by wOBA.)`);
process.exit(0);
