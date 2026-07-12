// Head-to-head: NATIVE tournament-trained model vs the LEAGUE model AS-IS (era-1920/park-169,
// NO tournament adjustment). Fit native on Early Gold days Jul 5-9, evaluate both on held-out
// days Jul 10-11. Reports Pearson AND Spearman for each event (BB,K,HR,1B,XBH) and for wOBA.
//
//   run: node tools/tournament-compare.ts

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs, type Coeffs } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../src/training/forms.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TDIR = "Tournament Data/Early Gold";
const TRAIN = ["5", "6", "7", "8", "9"], TEST = ["10", "11"]; // day tokens in "Early Gold July N.csv"
const TH = 250;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3), thr = (x: string) => (x === "R" ? 1 : 2);

// ── boot ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "early-gold")!;
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm: EventForm = trained.eventForm;
const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const W = wobaWeightsFromCoeffs(coeffs), HBP = coeffs.adv_hbp ?? 6;
const rpLeague = makeRawPolyModel(eventForm);

// ── aggregate per (CID,VLvl) for a set of day tokens ──
const dayTok = (f: string) => f.replace("Early Gold July ", "").replace(".csv", "");
interface Agg { r: any; hPA: number; hBB: number; hIBB: number; hHP: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number;
  pBF: number; pBB: number; pIBB: number; pHP: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
function aggregate(days: string[]) {
  const m = new Map<string, Agg>();
  let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
  for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv") && days.includes(dayTok(x)))) {
    for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
      const pa = num(r.PA), bf = num(r.BF);
      if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
      if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
      const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
      if (!a) { a = { r, hPA: 0, hBB: 0, hIBB: 0, hHP: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, pBF: 0, pBB: 0, pIBB: 0, pHP: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0 }; m.set(key, a); }
      a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.hHP += num(r.HP); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
      a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.pHP += num(r.HP_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1);
    }
  }
  return { m, wRhit: bfR / bfAll, wRpit: { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) } as Record<number, number> };
}
const tr = aggregate(TRAIN), te = aggregate(TEST);
const wRhit = tr.wRhit, wRpit = tr.wRpit;
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const hRat = (r: any, s: string) => ({ eye: R(r, s, "EYE"), pow: R(r, s, "POW"), kRat: R(r, s, "K"), babip: R(r, s, "BA"), gap: R(r, s, "GAP"), speed: 0, steal: 0, run: 0 });
const pRat = (r: any, s: string) => ({ con: R(r, s, "CON"), stu: R(r, s, "STU"), pbabip: R(r, s, "PBABIP"), hrr: R(r, s, "HRA") });
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
const blRatH = (r: any) => { const R2 = hRat(r, "vR"), L = hRat(r, "vL"); const o: any = { speed: 0, steal: 0, run: 0 }; for (const k of ["eye", "pow", "kRat", "babip", "gap"]) o[k] = bl((R2 as any)[k], (L as any)[k], wRhit); return o; };
const blRatP = (r: any, thrn: number) => { const R2 = pRat(r, "vR"), L = pRat(r, "vL"); const o: any = {}; for (const k of ["con", "stu", "pbabip", "hrr"]) o[k] = bl((R2 as any)[k], (L as any)[k], wRpit[thrn]!); return o; };

// ── fit native tournament model on TRAIN days (blended-rating combined obs) ──
const hitObs: any[] = [], pitObs: any[] = [];
for (const a of tr.m.values()) {
  if (a.hPA > 0) hitObs.push({ ratings: { hit: blRatH(a.r), pitch: pRat(a.r, "vR") }, hit: { PA: a.hPA, BB: a.hBB, K: a.hK, HR: a.hHR, H: a.h1B + a.h2B + a.h3B + a.hHR, b2: a.h2B, b3: a.h3B }, pitch: { BF: 0 } });
  if (a.pBF > 0) pitObs.push({ ratings: { hit: hRat(a.r, "vR"), pitch: blRatP(a.r, thr(String(a.r.T))) }, pitch: { BF: a.pBF, BB: a.pBB, K: a.pK, HR: a.pHR, b1: a.p1B, b2: a.p2B, b3: a.p3B }, hit: { PA: 0 } });
}
const tourneyForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, hitObs), pit: fitPitForm(STUFFAUG_PIT, pitObs) };
const rpTourney = makeRawPolyModel(tourneyForm);

// ── predicted event rates (per 600) for each model, combined via exposure blend ──
const asmH = (e: any) => (W.bb * e.BB + W.hbp * HBP + W.b1 * e.oneB + W.xbh * e.XBH + W.hr * e.HR) / 600;
const asmP = asmH;
const leagueHit = (r: any) => {
  const side = (s: "vR" | "vL") => { const e = rpLeague.predictHitting(hRat(r, s), coeffs); const k = hittingComponents(e, 1, 1, bats(String(r.B)), s, coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.SO * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; };
  const R2 = side("vR"), L = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "oneB", "XBH"]) o[k] = bl(R2[k as keyof typeof R2], L[k as keyof typeof L], wRhit); return o;
};
const leaguePit = (r: any) => {
  const w = wRpit[thr(String(r.T))]!;
  const side = (s: "vR" | "vL") => { const e = rpLeague.predictPitching(pRat(r, s), coeffs); const k = pitchingComponents(e, 1, 1, s, coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.K * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; };
  const R2 = side("vR"), L = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "oneB", "XBH"]) o[k] = bl(R2[k as keyof typeof R2], L[k as keyof typeof L], w); return o;
};
const tourHit = (r: any) => { const e = rpTourney.predictHitting(blRatH(r), coeffs); return { BB: e.BB, K: e.SO, HR: e.HR, oneB: e.oneB, XBH: e.GAP }; };
const tourPit = (r: any) => { const e = rpTourney.predictPitching(blRatP(r, thr(String(r.T))), coeffs); return { BB: e.BB, K: e.K, HR: e.HR, oneB: e.nHH - e.XBH, XBH: e.XBH }; };

// ── stats ──
const wp = (x: number[], y: number[], w: number[]) => { const m = (a: number[]) => a.reduce((s, v, i) => s + v * w[i]!, 0) / w.reduce((s, v) => s + v, 0); const mx = m(x), my = m(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { const dw = w[i]!, dx = x[i]! - mx, dy = y[i]! - my; a += dw * dx * dy; b += dw * dx * dx; c += dw * dy * dy; } return a / Math.sqrt(b * c); };
const sp = (x: number[], y: number[]) => { const rk = (a: number[]) => { const o = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k + 1)); return r as number[]; }; const rx = rk(x), ry = rk(y), n = x.length, mm = (n + 1) / 2; let c = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const dx = rx[i]! - mm, dy = ry[i]! - mm; c += dx * dy; sy += dy * dy; sx += dx * dx; } return c / Math.sqrt(sx * sy); };
const EV = ["BB", "K", "HR", "oneB", "XBH"];
const LBL: Record<string, string> = { BB: "BB", K: "K", HR: "HR", oneB: "1B", XBH: "XBH", woba: "wOBA" };

function report(role: "hit" | "pit") {
  const cards = [...te.m.values()].filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
  const w = cards.map((a) => (role === "hit" ? a.hPA : a.pBF));
  const actEv = (a: Agg, ev: string) => { const d = role === "hit" ? a.hPA : a.pBF; const g = (n: number) => n * 600 / d; return role === "hit"
    ? ({ BB: g(a.hBB), K: g(a.hK), HR: g(a.hHR), oneB: g(a.h1B), XBH: g(a.h2B + a.h3B) } as any)[ev]
    : ({ BB: g(a.pBB), K: g(a.pK), HR: g(a.pHR), oneB: g(a.p1B), XBH: g(a.p2B + a.p3B) } as any)[ev]; };
  const actWoba = (a: Agg) => { const d = role === "hit" ? a.hPA : a.pBF, g = (n: number) => n * 600 / d;
    return role === "hit" ? asmH({ BB: g(a.hBB - a.hIBB), oneB: g(a.h1B), XBH: g(a.h2B + a.h3B), HR: g(a.hHR) }) : asmP({ BB: g(a.pBB - a.pIBB), oneB: g(a.p1B), XBH: g(a.p2B + a.p3B), HR: g(a.pHR) }); };
  const models: [string, (r: any) => any][] = role === "hit" ? [["League (era-1920, no adj)", leagueHit], ["Tournament-trained", tourHit]] : [["League (era-1920, no adj)", leaguePit], ["Tournament-trained", tourPit]];
  const actE: Record<string, number[]> = {}; for (const ev of EV) actE[ev] = cards.map((a) => actEv(a, ev));
  const actW = cards.map((a) => actWoba(a));
  console.log(`\n===== ${role === "hit" ? "HITTERS" : "PITCHERS"} — held-out Jul 10-11, ≥${TH} ${role === "hit" ? "PA" : "BF"} (n=${cards.length}) =====`);
  for (const [metric, fn] of [["Pearson", wp] as const, ["Spearman", (x: number[], y: number[]) => sp(x, y)] as const]) {
    console.log(`  ${metric.padEnd(10)}  ${EV.map((e) => LBL[e]!.padStart(6)).join("")}${"wOBA".padStart(7)}`);
    for (const [name, pred] of models) {
      const P = cards.map((a) => pred(a.r));
      const cells = EV.map((ev) => (metric === "Pearson" ? wp(P.map((p) => p[ev]), actE[ev]!, w) : sp(P.map((p) => p[ev]), actE[ev]!)).toFixed(2).padStart(6));
      const wc = (metric === "Pearson" ? wp(cards.map((a) => (role === "hit" ? asmH : asmP)(pred(a.r))), actW, w) : sp(cards.map((a) => (role === "hit" ? asmH : asmP)(pred(a.r))), actW)).toFixed(2).padStart(7);
      console.log(`    ${name.padEnd(26)}${cells.join("")}${wc}`);
    }
  }
}
report("hit");
report("pit");
console.log(`\n(native fit on Jul 5-9: ${hitObs.length} hitter / ${pitObs.length} pitcher obs; both models evaluated fully out-of-sample on Jul 10-11.)`);
process.exit(0);
