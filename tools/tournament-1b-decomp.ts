// THROWAWAY DIAGNOSTIC — decompose the Early Gold 1B over-prediction into
//   (B) pool strength (opponent-gap re-basing of the H-channel / all channels)
//   (A) the era-1920 H factor level (configured era_h × parkAvg vs implied-by-actuals)
//   residual.
// Cross-checked on Return of the Bronze (era-2010/park-1, configured factor = 1).
//
//   run: node tools/tournament-1b-decomp.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { getParkFactor, cp } from "../src/scoring-core/helpers.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { HIT_BIP_ADJ, PIT_BIP_ADJ, type EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TH = 500;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3), thr = (x: string) => (x === "R" ? 1 : 2);
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const trained = (await repo.loadAll<any>("trained-models")).find((x: any) => x.id === state.activeModelId);
const eventForm: EventForm = trained.eventForm;
const rp = makeRawPolyModel(eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";

interface Agg { r: any; hPA: number; hBB: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number; hHP: number; hSH: number; hSF: number; pBF: number; pBB: number; p1B: number; p2B: number; p3B: number; pHR: number; pK: number; pHP: number }

type Mode = "off" | "opph" | "oppfull";

function runTournament(TDIR: string, TID: string) {
  const t = tournaments.find((x) => x.id === TID)!;
  const era = eras.get(t.eraId)!, park = parks.get(t.parkId)!;
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const derived = computeDerived(coeffs, true);

  // ── pool-strength gaps (same construction as tournament-ptdiag PTMODE=opp) ──
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const refF = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, 50, true);
  const poolF = computeUnifiedFieldStats(cat.cards.filter((c) => isB(c) && inV(c) && rowEligible(c as any, t)), coeffs, rp, 50, true);
  const gap = (role: "hit" | "pit", k: string) => (refF as any)[role].vR[k].mu - (poolF as any)[role].vR[k].mu;
  const OG = {
    hit: { eye: gap("pit", "con"), kRat: gap("pit", "stu"), pow: gap("pit", "hrr"), babip: gap("pit", "pbabip"), gap: gap("pit", "pbabip") },
    pit: { con: gap("hit", "eye"), stu: gap("hit", "kRat"), hrr: gap("hit", "pow"), pbabip: gap("hit", "babip") },
  } as any;

  // ── aggregate tournament actuals ──
  const m = new Map<string, Agg>();
  let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
  for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
    for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
      const pa = num(r.PA), bf = num(r.BF);
      if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
      if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
      const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
      if (!a) { a = { r, hPA: 0, hBB: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0, hHP: 0, hSH: 0, hSF: 0, pBF: 0, pBB: 0, p1B: 0, p2B: 0, p3B: 0, pHR: 0, pK: 0, pHP: 0 }; m.set(key, a); }
      a.hPA += pa; a.hBB += num(r.BB); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K); a.hHP += num(r.HP); a.hSH += num(r.SH); a.hSF += num(r.SF);
      a.pBF += bf; a.pBB += num(r.BB_1); a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]); a.pHR += num(r.HR_1); a.pK += num(r.K_1); a.pHP += num(r.HP_1);
    }
  }
  const wRhit = bfR / bfAll, wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
  const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
  const hRat = (r: any, s: string) => ({ eye: R(r, s, "EYE"), pow: R(r, s, "POW"), kRat: R(r, s, "K"), babip: R(r, s, "BA"), gap: R(r, s, "GAP"), speed: 0, steal: 0, run: 0 });
  const pRat = (r: any, s: string) => ({ con: R(r, s, "CON"), stu: R(r, s, "STU"), pbabip: R(r, s, "PBABIP"), hrr: R(r, s, "HRA") });
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  const txH = (o: any, mode: Mode) => mode === "off" ? o
    : mode === "opph" ? { ...o, babip: o.babip + OG.hit.babip, gap: o.gap + OG.hit.gap }
    : { eye: o.eye + OG.hit.eye, pow: o.pow + OG.hit.pow, kRat: o.kRat + OG.hit.kRat, babip: o.babip + OG.hit.babip, gap: o.gap + OG.hit.gap, speed: 0, steal: 0, run: 0 };
  const txP = (o: any, mode: Mode) => mode === "off" ? o
    : mode === "opph" ? { ...o, pbabip: o.pbabip + OG.pit.pbabip }
    : { con: o.con + OG.pit.con, stu: o.stu + OG.pit.stu, pbabip: o.pbabip + OG.pit.pbabip, hrr: o.hrr + OG.pit.hrr };

  // Per-card blended prediction. hMult scales the H-chain level (BA_fin and GAP_fin
  // scale proportionally, so post-hoc scaling of oneB/XBH is EXACT — no 2nd math copy).
  // Also returns nHHpre = the H level BEFORE era_h × parkAvg (exact inversion), and predBIP.
  const predHit = (r: any, mode: Mode, hMult = 1) => {
    const b = bats(String(r.B));
    const side = (s: "vR" | "vL") => {
      const e = rp.predictHitting(txH(hRat(r, s), mode), coeffs);
      const k = hittingComponents(e, 1, 1, b, s, coeffs, derived, eventForm);
      const parkAvg = getParkFactor(b, s === "vR", coeffs.park_avg_r, coeffs.park_avg_l);
      const nHH = k.oneB_fin + k.GAP_fin;
      const BIP = Math.max(600 - k.BB_fin - e.SO * coeffs.era_k - k.HR_fin - HIT_BIP_ADJ, 1);
      return { oneB: k.oneB_fin * hMult, XBH: k.GAP_fin * hMult, nHH: nHH * hMult, nHHpre: nHH / (derived.era_h * parkAvg), BIP };
    };
    const A = side("vR"), B = side("vL"), o: any = {};
    for (const k of ["oneB", "XBH", "nHH", "nHHpre", "BIP"]) o[k] = bl((A as any)[k], (B as any)[k], wRhit);
    return o;
  };
  const predPit = (r: any, mode: Mode, hMult = 1) => {
    const w = wRpit[thr(String(r.T))]!;
    const side = (s: "vR" | "vL") => {
      const e = rp.predictPitching(txP(pRat(r, s), mode), coeffs);
      const k = pitchingComponents(e, 1, 1, s, coeffs, derived, eventForm);
      const parkAvg = cp(s === "vR" ? coeffs.park_avg_r : coeffs.park_avg_l);
      const nHH = k.oneB_fin + k.XBH_fin;
      const BIP = Math.max(600 - k.BB_fin - e.K * coeffs.era_k - k.HR_fin - PIT_BIP_ADJ, 1);
      return { oneB: k.oneB_fin * hMult, XBH: k.XBH_fin * hMult, nHH: nHH * hMult, nHHpre: nHH / (derived.era_h * parkAvg), BIP };
    };
    const A = side("vR"), B = side("vL"), o: any = {};
    for (const k of ["oneB", "XBH", "nHH", "nHHpre", "BIP"]) o[k] = bl((A as any)[k], (B as any)[k], w);
    return o;
  };

  const confFactorNote = `era_h=${derived.era_h.toFixed(4)} (from era_avg=${era.avg}, era_hr=${era.hr}), cp(park_avg)=${cp(coeffs.park_avg_r).toFixed(4)}/${cp(coeffs.park_avg_l).toFixed(4)} → configured H mult ≈ ${(derived.era_h * cp(coeffs.park_avg_r)).toFixed(4)}`;
  console.log(`\n${"=".repeat(90)}\n=== ${t.name} (${TID})  era=${t.eraId} park=${t.parkId}\n${"=".repeat(90)}`);
  console.log(confFactorNote);
  console.log(`opp gaps (ref−pool, opposing channel): hit ${JSON.stringify(Object.fromEntries(Object.entries(OG.hit).map(([k, v]) => [k, +(v as number).toFixed(1)])))}  pit ${JSON.stringify(Object.fromEntries(Object.entries(OG.pit).map(([k, v]) => [k, +(v as number).toFixed(1)])))}`);

  const results: any = {};
  for (const role of ["hit", "pit"] as const) {
    const cs = [...m.values()].filter((a) => (role === "hit" ? a.hPA : a.pBF) >= TH);
    const w = cs.map((a) => (role === "hit" ? a.hPA : a.pBF));
    const g = (a: Agg, n: number) => n * 600 / (role === "hit" ? a.hPA : a.pBF);
    const act = (a: Agg) => role === "hit"
      ? { oneB: g(a, a.h1B), XBH: g(a, a.h2B + a.h3B), nHH: g(a, a.h1B + a.h2B + a.h3B), BIP: 600 - g(a, a.hBB + a.hK + a.hHR + a.hHP + a.hSH - a.hSF) }
      : { oneB: g(a, a.p1B), XBH: g(a, a.p2B + a.p3B), nHH: g(a, a.p1B + a.p2B + a.p3B), BIP: 600 - g(a, a.pBB + a.pK + a.pHR + a.pHP) };
    const A = { oneB: wmean(cs.map((a) => act(a).oneB), w), XBH: wmean(cs.map((a) => act(a).XBH), w), nHH: wmean(cs.map((a) => act(a).nHH), w), BIP: wmean(cs.map((a) => act(a).BIP), w) };

    const agg = (mode: Mode, hMult = 1) => {
      const p = cs.map((a) => (role === "hit" ? predHit(a.r, mode, hMult) : predPit(a.r, mode, hMult)));
      return { oneB: wmean(p.map((x) => x.oneB), w), XBH: wmean(p.map((x) => x.XBH), w), nHH: wmean(p.map((x) => x.nHH), w), nHHpre: wmean(p.map((x) => x.nHHpre), w), BIP: wmean(p.map((x) => x.BIP), w) };
    };
    const OFF = agg("off"), OPPH = agg("opph"), FULL = agg("oppfull");

    // configured effective factor (exposure-weighted, exact): predFin / predPre
    const conf = FULL.nHH / FULL.nHHpre;
    // implied factors
    const implOFF = A.nHH / OFF.nHHpre;                       // no pool handling
    const implFULL = A.nHH / FULL.nHHpre;                     // pool handled (per-600 framing)
    const implPerBIP = (A.nHH / A.BIP) / (FULL.nHHpre / FULL.BIP); // per-BIP framing (BIP errors removed)
    const SCALED = agg("oppfull", implFULL / conf);           // era factor replaced by implied

    const roleName = role === "hit" ? "HITTERS" : "PITCHERS";
    const line = (lbl: string, v: any) => console.log(`  ${lbl.padEnd(26)} ${v.oneB.toFixed(1).padStart(7)} ${(v.oneB - A.oneB).toFixed(1).padStart(7)} | ${v.XBH.toFixed(1).padStart(6)} ${(v.XBH - A.XBH).toFixed(1).padStart(6)} | ${v.nHH.toFixed(1).padStart(6)} ${(v.nHH - A.nHH).toFixed(1).padStart(6)} | ${v.BIP.toFixed(1).padStart(6)} ${(v.BIP - A.BIP).toFixed(1).padStart(6)}`);
    console.log(`\n--- ${roleName} (n=${cs.length}, ${role === "hit" ? "PA" : "BF"}-weighted, per 600) ---`);
    console.log(`  ${"".padEnd(26)} ${"1B".padStart(7)} ${"bias".padStart(7)} | ${"XBH".padStart(6)} ${"bias".padStart(6)} | ${"nHH".padStart(6)} ${"bias".padStart(6)} | ${"BIP".padStart(6)} ${"bias".padStart(6)}`);
    console.log(`  ${"ACTUAL".padEnd(26)} ${A.oneB.toFixed(1).padStart(7)} ${"".padStart(7)} | ${A.XBH.toFixed(1).padStart(6)} ${"".padStart(6)} | ${A.nHH.toFixed(1).padStart(6)} ${"".padStart(6)} | ${A.BIP.toFixed(1).padStart(6)}`);
    line("pred OFF (baseline)", OFF);
    line("pred OPP H-channel only", OPPH);
    line("pred OPP full", FULL);
    line("pred OPP full + implied f", SCALED);
    console.log(`  H factor: configured=${conf.toFixed(4)}  implied(no pool)=${implOFF.toFixed(4)}  implied(pool-handled)=${implFULL.toFixed(4)}  implied(per-BIP)=${implPerBIP.toFixed(4)}`);
    console.log(`  XBH share: actual=${(A.XBH / A.nHH).toFixed(3)}  model(OPP full)=${(FULL.XBH / FULL.nHH).toFixed(3)}`);
    results[role] = { A, OFF, OPPH, FULL, SCALED, conf, implOFF, implFULL, implPerBIP };
  }
  return results;
}

const eg = runTournament("Tournament Data/Early Gold", "early-gold");
const br = runTournament("Tournament Data/Return of the Bronze", "bronze-return");

// ── decomposition summary (1B bias per 600) ──
console.log(`\n${"=".repeat(90)}\n=== 1B-bias decomposition summary (per 600; attribution order: pool first, then era factor) ===`);
console.log(`  tournament  role   biasOFF   pool(H-ch)  pool(other-ch)  era-factor  residual`);
for (const [nm, r] of [["early-gold", eg], ["bronze-ret", br]] as const) {
  for (const role of ["hit", "pit"] as const) {
    const x = (r as any)[role];
    const b0 = x.OFF.oneB - x.A.oneB, b1 = x.OPPH.oneB - x.A.oneB, b2 = x.FULL.oneB - x.A.oneB, b3 = x.SCALED.oneB - x.A.oneB;
    console.log(`  ${nm.padEnd(11)} ${role.padEnd(5)} ${b0.toFixed(1).padStart(8)} ${(b0 - b1).toFixed(1).padStart(11)} ${(b1 - b2).toFixed(1).padStart(15)} ${(b2 - b3).toFixed(1).padStart(11)} ${b3.toFixed(1).padStart(9)}`);
  }
}
process.exit(0);
