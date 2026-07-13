// PER-CHANNEL off-frame separation (not just K). For each tier × role × event channel (BB, K, HR,
// H−HR) compute s* = the spread scale the data wants after the opp-gap LEVEL shift (frame-v2 shift,
// NO per-channel spread correction applied): s>1 ⇒ the model UNDER-separates that channel off-frame
// (predicted spread too narrow), s≈1 ⇒ fine, s<1 ⇒ over-separates. Centered on the PA/BF-weighted
// participant mean of the predicted event. Tells us which channels need a tail (K is the known one)
// and whether StuffAug's BB/HR Stuff-aux still looks needed once the opp-frame is in.
//   run: node tools/quicks-channels.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildFrameShift, computeDerived } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { loadTournamentOutcomes, tournamentExposure, type TournamentObs } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const FIELD_N = 50, TH = 300;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm = trained.eventForm;
const rp = makeRawPolyModel(eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const thr = (x: number) => (x === 1 ? 1 : 2);
const sh = (v: number, d: number | undefined) => (d ? Math.max(0, v + d) : v);

interface Ev { BB: number; K: number; HR: number; HmHR: number }
// s* fit for one channel: WLS of actual deviation on predicted deviation, centered on μ_pred.
function sStar(rows: { p: number; a: number; w: number }[]) {
  const sw = rows.reduce((s, r) => s + r.w, 0);
  const mp = rows.reduce((s, r) => s + r.w * r.p, 0) / sw, ma = rows.reduce((s, r) => s + r.w * r.a, 0) / sw;
  let nu = 0, de = 0; for (const r of rows) { nu += r.w * (r.p - mp) * (r.a - mp); de += r.w * (r.p - mp) ** 2; }
  return { s: nu / de, bias: mp - ma };
}

for (const [name, TDIR, TID] of [["Open", "Tournament Data/Quicks - Open", "default-neutral"], ["Bronze", "Tournament Data/Quicks - Bronze", "bronze-quick"], ["Gold", "Tournament Data/Quicks - Gold", "gold-quick"]] as const) {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const derived = computeDerived(coeffs, true);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  const hitEv = (o: TournamentObs, side: "vR" | "vL"): Ev => {
    const d = fs.hit[side], r = o.ratings.hit[side];
    const e = rp.predictHitting({ eye: sh(r.eye, d.eye), pow: sh(r.pow, d.pow), kRat: sh(r.kRat, d.kRat), babip: sh(r.babip, d.babip), gap: sh(r.gap, d.gap), speed: 0, steal: 0, run: 0 }, coeffs);
    const k = hittingComponents(e, 1, 1, o.bats, side, coeffs, derived, eventForm);
    return { BB: k.BB_fin, K: e.SO * coeffs.era_k, HR: k.HR_fin, HmHR: k.oneB_fin + k.GAP_fin };
  };
  const pitEv = (o: TournamentObs, side: "vR" | "vL"): Ev => {
    const d = fs.pit[side], r = o.ratings.pit[side];
    const e = rp.predictPitching({ con: sh(r.con, d.con), stu: sh(r.stu, d.stu), pbabip: sh(r.pbabip, d.pbabip), hrr: sh(r.hrr, d.hrr) }, coeffs);
    const k = pitchingComponents(e, 1, 1, side, coeffs, derived, eventForm);
    return { BB: k.BB_fin, K: e.K * coeffs.era_k, HR: k.HR_fin, HmHR: k.oneB_fin + k.XBH_fin };
  };

  const chan = (role: "hit" | "pit") => {
    const key = role === "hit" ? "pa" : "bf";
    const pred = role === "hit" ? hitEv : pitEv;
    const cards = obs.filter((o: any) => o[key] >= TH);
    const wR = (o: TournamentObs) => (role === "hit" ? exposure.wRhit : exposure.wRpit[thr(o.throws)]!);
    const out: Record<keyof Ev, { s: number; bias: number }> = {} as any;
    for (const ev of ["BB", "K", "HR", "HmHR"] as (keyof Ev)[]) {
      const rows = cards.map((o: any) => ({ p: bl(pred(o, "vR")[ev], pred(o, "vL")[ev], wR(o)), a: (o.actual[role] as any)[ev === "BB" ? "uBB" : ev], w: o[key] }));
      out[ev] = sStar(rows);
    }
    return { n: cards.length, out };
  };

  console.log(`\n======== QUICKS ${name} (${t.eraId}, val≤${t.card_value_max ?? "∞"}) ========`);
  console.log(`  frame gaps: hit eye ${(fs.hit.vR.eye ?? 0).toFixed(0)} kRat ${(fs.hit.vR.kRat ?? 0).toFixed(0)} pow ${(fs.hit.vR.pow ?? 0).toFixed(0)} | pit con ${(fs.pit.vR.con ?? 0).toFixed(0)} stu ${(fs.pit.vR.stu ?? 0).toFixed(0)} hrr ${(fs.pit.vR.hrr ?? 0).toFixed(0)}`);
  for (const role of ["hit", "pit"] as const) {
    const c = chan(role);
    const cell = (ev: keyof Ev) => { const x = c.out[ev]; const flag = x.s > 1.2 ? " UNDER" : x.s < 0.8 ? " over" : ""; return `${ev === "HmHR" ? "H-HR" : ev} s*${x.s.toFixed(2)}${flag} (bias ${x.bias >= 0 ? "+" : ""}${x.bias.toFixed(1)})`; };
    console.log(`  ${role.toUpperCase()} (N=${c.n}):  ${(["BB", "K", "HR", "HmHR"] as (keyof Ev)[]).map(cell).join("   ")}`);
  }
}
console.log(`\n(s*>1.2 = channel UNDER-separates off-frame → wants a tail; ≈1 = fine; the OPEN row is ~in-frame ⇒ should be ≈1 everywhere. bias = level residual /600.)`);
process.exit(0);
