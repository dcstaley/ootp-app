// Is the tournament K∼STU slope steepening a ROLE-MIX artifact? Split pitchers ≥TH BF into
// SP (mostly starts) vs RP and redo the K/600-by-STU quintile bias with the opponent-gap
// transform ON. If within-role bias is flat, the slope came from role mix (times-through-order);
// if the under-separation persists within role, it's a real matchup/curve effect.
//
//   run: node tools/tournament-role-k.ts
//        TD="Tournament Data/Return of the Bronze" TID=bronze-return node tools/tournament-role-k.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TDIR = process.env.TD ?? "Tournament Data/Early Gold";
const TID = process.env.TID ?? "early-gold";
const TH = Number(process.env.TH ?? 500);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const thr = (x: string) => (x === "R" ? 1 : 2);

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

const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
const refF = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, 50, true);
const poolF = computeUnifiedFieldStats(cat.cards.filter((c) => isB(c) && inV(c) && rowEligible(c as any, t)), coeffs, rp, 50, true);
const gap = (role: "hit" | "pit", k: string) => (refF as any)[role].vR[k].mu - (poolF as any)[role].vR[k].mu;
const OG = { con: gap("hit", "eye"), stu: gap("hit", "kRat"), hrr: gap("hit", "pow"), pbabip: gap("hit", "babip") };

interface Agg { r: any; pBF: number; pBB: number; pK: number; pG: number; pGS: number }
const m = new Map<string, Agg>();
let paR = 0, paL = 0, paS = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
    const pa = num(r.PA);
    if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
    const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
    if (!a) { a = { r, pBF: 0, pBB: 0, pK: 0, pG: 0, pGS: 0 }; m.set(key, a); }
    a.pBF += num(r.BF); a.pBB += num(r.BB_1); a.pK += num(r.K_1); a.pG += num(r.G_2); a.pGS += num(r.GS_2);
  }
}
const wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const pRat = (r: any, s: string) => ({ con: R(r, s, "CON") + OG.con, stu: R(r, s, "STU") + OG.stu, pbabip: R(r, s, "PBABIP") + OG.pbabip, hrr: R(r, s, "HRA") + OG.hrr });
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
const predK = (r: any) => { const w = wRpit[thr(String(r.T))]!; const side = (s: "vR" | "vL") => rp.predictPitching(pRat(r, s), coeffs).K * coeffs.era_k; return bl(side("vR"), side("vL"), w); };
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

const cs = [...m.values()].filter((a) => a.pBF >= TH);
const roleOf = (a: Agg) => (a.pGS >= a.pG / 2 ? "SP" : "RP");
console.log(`tournament=${t.id}  pitchers >=${TH} BF: ${cs.length}  (SP ${cs.filter((a) => roleOf(a) === "SP").length} / RP ${cs.filter((a) => roleOf(a) === "RP").length})  opp-gap lifts: ${JSON.stringify(Object.fromEntries(Object.entries(OG).map(([k, v]) => [k, +(v as number).toFixed(1)])))}`);
for (const role of ["SP", "RP"] as const) {
  const grp = cs.filter((a) => roleOf(a) === role).map((a) => ({ stu: bl(R(a.r, "vR", "STU"), R(a.r, "vL", "STU"), wRpit[thr(String(a.r.T))]!), w: a.pBF, act: a.pK * 600 / a.pBF, pred: predK(a.r) })).sort((x, y) => x.stu - y.stu);
  console.log(`\n=== ${role} — K/600 by raw STU quintile (opp-gap PT ON) ===`);
  console.log(`  quint  meanSTU  ACTUAL    PRED  (bias)     n`);
  const q = Math.ceil(grp.length / 5);
  for (let i = 0; i < 5; i++) {
    const g = grp.slice(i * q, (i + 1) * q); if (!g.length) continue;
    const w = g.map((x) => x.w);
    const act = wmean(g.map((x) => x.act), w), pred = wmean(g.map((x) => x.pred), w);
    console.log(`  Q${i + 1}   ${wmean(g.map((x) => x.stu), w).toFixed(0).padStart(6)}  ${act.toFixed(1).padStart(7)} ${pred.toFixed(1).padStart(7)}  (${(pred - act >= 0 ? "+" : "")}${(pred - act).toFixed(1)})  ${String(g.length).padStart(4)}`);
  }
}
process.exit(0);
