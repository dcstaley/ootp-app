// Pool-transform diagnostic on Early Gold: (1) how big is the transform really — ref vs pool
// field means, k's, envelope ceilings, effective lift at pool-typical ratings; (2) what it does
// to LEVEL BIAS — per-event mean (pred − act) with transform ON vs OFF, plus pitcher BB by CON
// quintile (the CON→BB over-prediction) and hitter BB by EYE quintile.
//
//   run: node tools/tournament-ptdiag.ts            (Early Gold)
//        TD="Tournament Data/Return of the Bronze" TID=bronze-return node tools/tournament-ptdiag.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats, buildPoolTransform, applyAffine, type PoolTransform } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TDIR = process.env.TD ?? "Tournament Data/Early Gold";
const TID = process.env.TID ?? "early-gold";
const TH = Number(process.env.TH ?? 500);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
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
const rp = makeRawPolyModel(eventForm);

// ---- build the transform exactly as the cv script does ----
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
const refF = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, 50, true);
const poolF = computeUnifiedFieldStats(cat.cards.filter((c) => isB(c) && inV(c) && rowEligible(c as any, t)), coeffs, rp, 50, true);
const env = trained.ratingEnvelope ?? undefined;
const pt: PoolTransform = buildPoolTransform(refF, poolF, env);

console.log(`tournament=${t.id}  card_value range: ${t.card_value_min ?? "-"}..${t.card_value_max ?? "-"}  envelope on artifact: ${env ? "YES" : "NO"}`);
console.log(`\n=== Transform anatomy (side-unified; vR shown) ===`);
console.log(`rating     refMu   poolMu      k   ceilC   fadeCtr   width | eff@poolMu (lift) | eff@poolMu+sd`);
const show = (role: "hit" | "pit", keys: string[]) => {
  for (const k of keys) {
    const r = (refF as any)[role].vR[k], p = (poolF as any)[role].vR[k], m = (pt as any)[role].vR[k];
    if (!m) { console.log(`${k.padEnd(8)} (no map)`); continue; }
    const eff1 = applyAffine(p.mu, m), eff2 = applyAffine(p.mu + p.sd, m);
    const ctr = Number.isFinite(m.c) ? (m.c * 0.88).toFixed(0) : "inf";
    console.log(`${(role === "pit" ? "P." : "H.") + k.padEnd(6)} ${r.mu.toFixed(1).padStart(7)} ${p.mu.toFixed(1).padStart(8)} ${m.k.toFixed(3).padStart(7)} ${(Number.isFinite(m.c) ? m.c.toFixed(0) : "inf").padStart(7)} ${String(ctr).padStart(9)} ${(Number.isFinite(m.w) ? m.w.toFixed(1) : "inf").padStart(7)} | ${eff1.toFixed(1).padStart(8)} (${(eff1 - p.mu >= 0 ? "+" : "")}${(eff1 - p.mu).toFixed(1)}) | ${eff2.toFixed(1).padStart(8)}`);
  }
};
show("hit", ["eye", "pow", "kRat", "babip", "gap"]);
show("pit", ["con", "stu", "pbabip", "hrr"]);

// ---- aggregate tournament actuals ----
interface Agg { r: any; hPA: number; hBB: number; hIBB: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number; pBF: number; pBB: number; pIBB: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number }
const m = new Map<string, Agg>();
let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
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
// OPPONENT-GAP mode (PTMODE=opp): outcomes are matchup-difference driven, so the correct
// re-basing shifts each rating ADDITIVELY by the OPPOSING channel's mean gap (ref − pool):
//   BB channel: H.eye ↔ P.con     K channel: H.kRat ↔ P.stu
//   HR channel: H.pow ↔ P.hrr     BIP/H:      H.babip/gap ↔ P.pbabip
const OPP = process.env.PTMODE === "opp";
const gap = (role: "hit" | "pit", k: string) => (refF as any)[role].vR[k].mu - (poolF as any)[role].vR[k].mu;
const OG = {
  hit: { eye: gap("pit", "con"), kRat: gap("pit", "stu"), pow: gap("pit", "hrr"), babip: gap("pit", "pbabip"), gap: gap("pit", "pbabip") },
  pit: { con: gap("hit", "eye"), stu: gap("hit", "kRat"), hrr: gap("hit", "pow"), pbabip: gap("hit", "babip") },
} as any;
if (OPP) console.log(`\n[PTMODE=opp] additive opponent-gap lifts: hit ${JSON.stringify(Object.fromEntries(Object.entries(OG.hit).map(([k, v]) => [k, +(v as number).toFixed(1)])))} pit ${JSON.stringify(Object.fromEntries(Object.entries(OG.pit).map(([k, v]) => [k, +(v as number).toFixed(1)])))}`);
const txH = (s: "vR" | "vL", o: any, on: boolean) => !on ? o
  : OPP ? { eye: o.eye + OG.hit.eye, pow: o.pow + OG.hit.pow, kRat: o.kRat + OG.hit.kRat, babip: o.babip + OG.hit.babip, gap: o.gap + OG.hit.gap, speed: 0, steal: 0, run: 0 }
  : { eye: applyAffine(o.eye, (pt.hit as any)[s].eye), pow: applyAffine(o.pow, (pt.hit as any)[s].pow), kRat: applyAffine(o.kRat, (pt.hit as any)[s].kRat), babip: applyAffine(o.babip, (pt.hit as any)[s].babip), gap: applyAffine(o.gap, (pt.hit as any)[s].gap), speed: 0, steal: 0, run: 0 };
const txP = (s: "vR" | "vL", o: any, on: boolean) => !on ? o
  : OPP ? { con: o.con + OG.pit.con, stu: o.stu + OG.pit.stu, pbabip: o.pbabip + OG.pit.pbabip, hrr: o.hrr + OG.pit.hrr }
  : { con: applyAffine(o.con, (pt.pit as any)[s].con), stu: applyAffine(o.stu, (pt.pit as any)[s].stu), pbabip: applyAffine(o.pbabip, (pt.pit as any)[s].pbabip), hrr: applyAffine(o.hrr, (pt.pit as any)[s].hrr) };
const leagueHit = (r: any, on: boolean) => { const side = (s: "vR" | "vL") => { const e = rp.predictHitting(txH(s, hRat(r, s), on), coeffs); const k = hittingComponents(e, 1, 1, bats(String(r.B)), s, coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.SO * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.GAP_fin }; }; const A = side("vR"), B = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "oneB", "XBH"]) o[k] = bl((A as any)[k], (B as any)[k], wRhit); return o; };
const leaguePit = (r: any, on: boolean) => { const w = wRpit[thr(String(r.T))]!; const side = (s: "vR" | "vL") => { const e = rp.predictPitching(txP(s, pRat(r, s), on), coeffs); const k = pitchingComponents(e, 1, 1, s, coeffs, derived, eventForm); return { BB: k.BB_fin, K: e.K * coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, XBH: k.XBH_fin }; }; const A = side("vR"), B = side("vL"), o: any = {}; for (const k of ["BB", "K", "HR", "oneB", "XBH"]) o[k] = bl((A as any)[k], (B as any)[k], w); return o; };

const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);
const EV = ["BB", "K", "HR", "oneB", "XBH"] as const;

function biasTable(role: "hit" | "pit") {
  const cs = [...m.values()].filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
  const w = cs.map((a) => (role === "hit" ? a.hPA : a.pBF));
  const g = (a: Agg, n: number) => n * 600 / (role === "hit" ? a.hPA : a.pBF);
  const act = (a: Agg): any => role === "hit"
    ? { BB: g(a, a.hBB), K: g(a, a.hK), HR: g(a, a.hHR), oneB: g(a, a.h1B), XBH: g(a, a.h2B + a.h3B) }
    : { BB: g(a, a.pBB), K: g(a, a.pK), HR: g(a, a.pHR), oneB: g(a, a.p1B), XBH: g(a, a.p2B + a.p3B) };
  console.log(`\n=== ${role === "hit" ? "HITTER" : "PITCHER"} level bias, mean(pred − act) per 600 (n=${cs.length}, PA/BF-weighted) ===`);
  console.log(`             ${EV.map((e) => e.padStart(7)).join("")}`);
  for (const on of [false, true]) {
    const pred = cs.map((a) => (role === "hit" ? leagueHit(a.r, on) : leaguePit(a.r, on)));
    const cells = EV.map((ev) => (wmean(pred.map((p) => p[ev]), w) - wmean(cs.map((a) => act(a)[ev]), w)).toFixed(1).padStart(7));
    console.log(`  PT ${on ? "ON " : "OFF"}    ${cells.join("")}`);
  }
  const actual = EV.map((ev) => wmean(cs.map((a) => act(a)[ev]), w).toFixed(1).padStart(7));
  console.log(`  (actual)  ${actual.join("")}`);
}
biasTable("hit"); biasTable("pit");

// pitcher BB by CON quintile, PT on/off
function quintiles(role: "hit" | "pit", ratKey: string, ev: string) {
  const cs = [...m.values()].filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
  const g = (a: Agg, n: number) => n * 600 / (role === "hit" ? a.hPA : a.pBF);
  const ratOf = (a: Agg) => role === "hit"
    ? bl(hRat(a.r, "vR")[ratKey as "eye"], hRat(a.r, "vL")[ratKey as "eye"], wRhit)
    : bl(pRat(a.r, "vR")[ratKey as "con"], pRat(a.r, "vL")[ratKey as "con"], wRpit[thr(String(a.r.T))]!);
  const actOf = (a: Agg) => role === "hit"
    ? ({ BB: g(a, a.hBB), K: g(a, a.hK) } as any)[ev]
    : ({ BB: g(a, a.pBB), K: g(a, a.pK) } as any)[ev];
  const rows = cs.map((a) => ({ a, rat: ratOf(a), w: role === "hit" ? a.hPA : a.pBF, act: actOf(a), off: (role === "hit" ? leagueHit(a.r, false) : leaguePit(a.r, false))[ev], on: (role === "hit" ? leagueHit(a.r, true) : leaguePit(a.r, true))[ev] })).sort((x, y) => x.rat - y.rat);
  console.log(`\n=== ${role === "pit" ? "Pitcher" : "Hitter"} ${ev}/600 by ${ratKey.toUpperCase()} quintile ===`);
  console.log(`  quint  mean${ratKey.toUpperCase().padEnd(5)}  ACTUAL   PT-OFF  (bias)   PT-ON   (bias)`);
  const q = Math.ceil(rows.length / 5);
  for (let i = 0; i < 5; i++) {
    const grp = rows.slice(i * q, (i + 1) * q); if (!grp.length) continue;
    const w = grp.map((x) => x.w);
    const act = wmean(grp.map((x) => x.act), w), off = wmean(grp.map((x) => x.off), w), on = wmean(grp.map((x) => x.on), w);
    console.log(`  Q${i + 1}    ${wmean(grp.map((x) => x.rat), w).toFixed(0).padStart(6)}   ${act.toFixed(1).padStart(6)}   ${off.toFixed(1).padStart(6)}  (${(off - act >= 0 ? "+" : "")}${(off - act).toFixed(1)})   ${on.toFixed(1).padStart(6)}  (${(on - act >= 0 ? "+" : "")}${(on - act).toFixed(1)})`);
  }
}
quintiles("pit", "con", "BB");
quintiles("pit", "stu", "K");
quintiles("hit", "eye", "BB");
quintiles("hit", "kRat", "K");
process.exit(0);
