// Does the NATIVE tournament model handle the WALK channel differently from the LEAGUE model?
// Compares, for hitters >=500 PA, each model's predicted BB rate vs actual, by EYE-rating bin,
// plus the EYE→BB slope and the calibration slope (actual BB regressed on predicted BB). If the
// league model over-SEPARATES walks by EYE (too-steep slope) that's the "BB over-valuation";
// a native fit on real outcomes should match the actual slope better.
//
//   run: node tools/tournament-bb.ts

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, wobaWeightsFromCoeffs } from "../src/scoring-core/index.ts";
import { hittingComponents } from "../src/scoring-core/woba.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../src/training/forms.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TDIR = "Tournament Data/Early Gold", TH = 500;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bats = (b: string) => (b === "R" ? 1 : b === "L" ? 2 : 3), thr = (x: string) => (x === "R" ? 1 : 2);

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
const rpLeague = makeRawPolyModel(eventForm);

interface Agg { r: any; hPA: number; hBB: number; h1B: number; h2B: number; h3B: number; hHR: number; hK: number }
const m = new Map<string, Agg>();
let bfR = 0, bfAll = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
    const bf = num(r.BF); if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
    const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
    if (!a) { a = { r, hPA: 0, hBB: 0, h1B: 0, h2B: 0, h3B: 0, hHR: 0, hK: 0 }; m.set(key, a); }
    a.hPA += num(r.PA); a.hBB += num(r.BB); a.h1B += num(r["1B_1"]); a.h2B += num(r["2B_1"]); a.h3B += num(r["3B_1"]); a.hHR += num(r.HR); a.hK += num(r.K);
  }
}
const wRhit = bfR / bfAll;
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const hRat = (r: any, s: string) => ({ eye: R(r, s, "EYE"), pow: R(r, s, "POW"), kRat: R(r, s, "K"), babip: R(r, s, "BA"), gap: R(r, s, "GAP"), speed: 0, steal: 0, run: 0 });
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
const blH = (r: any) => { const A = hRat(r, "vR"), B = hRat(r, "vL"), o: any = { speed: 0, steal: 0, run: 0 }; for (const k of ["eye", "pow", "kRat", "babip", "gap"]) o[k] = bl((A as any)[k], (B as any)[k], wRhit); return o; };

// native fit on all cards (characterizing the model's fitted BB behavior)
const obs = [...m.values()].filter((a) => a.hPA > 0).map((a) => ({ ratings: { hit: blH(a.r), pitch: hRat(a.r, "vR") as any }, hit: { PA: a.hPA, BB: a.hBB, K: a.hK, HR: a.hHR, H: a.h1B + a.h2B + a.h3B + a.hHR, b2: a.h2B, b3: a.h3B }, pitch: { BF: 0 } }));
const pobs = [{ ratings: { hit: hRat([...m.values()][0]!.r, "vR") as any, pitch: { con: 100, stu: 100, pbabip: 100, hrr: 100 } }, pitch: { BF: 1000, BB: 40, K: 100, HR: 10, b1: 100, b2: 30, b3: 5 }, hit: { PA: 0 } }];
const nativeForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, obs as any), pit: fitPitForm(STUFFAUG_PIT, pobs as any) };
const rpNative = makeRawPolyModel(nativeForm);

const leagueBB = (r: any) => bl(hittingComponents(rpLeague.predictHitting(hRat(r, "vR"), coeffs), 1, 1, bats(String(r.B)), "vR", coeffs, derived, eventForm).BB_fin, hittingComponents(rpLeague.predictHitting(hRat(r, "vL"), coeffs), 1, 1, bats(String(r.B)), "vL", coeffs, derived, eventForm).BB_fin, wRhit);
const nativeBB = (r: any) => rpNative.predictHitting(blH(r), coeffs).BB;

const cs = [...m.values()].filter((a) => a.hPA >= TH);
const rows = cs.map((a) => ({ eye: blH(a.r).eye, w: a.hPA, act: a.hBB * 600 / a.hPA, lg: leagueBB(a.r), nv: nativeBB(a.r) }));

// weighted slope of y on x
const wslope = (x: number[], y: number[], w: number[]) => { const mn = (v: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0); const mx = mn(x), my = mn(y); let a = 0, b = 0; for (let i = 0; i < x.length; i++) { a += w[i]! * (x[i]! - mx) * (y[i]! - my); b += w[i]! * (x[i]! - mx) ** 2; } return a / b; };
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

console.log(`\n=== WALK channel: league vs native tournament model (hitters >=${TH} PA, n=${cs.length}) ===`);
console.log(`\nBB/600 by EYE-rating quintile (mean):`);
console.log(`  quintile   n   meanEYE   ACTUAL   league   native   (lg−act)  (nv−act)`);
const sorted = [...rows].sort((a, b) => a.eye - b.eye);
const q = Math.ceil(sorted.length / 5);
for (let i = 0; i < 5; i++) {
  const g = sorted.slice(i * q, (i + 1) * q); if (!g.length) continue;
  const w = g.map((x) => x.w);
  const act = wmean(g.map((x) => x.act), w), lg = wmean(g.map((x) => x.lg), w), nv = wmean(g.map((x) => x.nv), w);
  console.log(`  Q${i + 1}  ${String(g.length).padStart(6)}   ${wmean(g.map((x) => x.eye), w).toFixed(0).padStart(5)}   ${act.toFixed(1).padStart(6)}   ${lg.toFixed(1).padStart(6)}   ${nv.toFixed(1).padStart(6)}   ${(lg - act).toFixed(1).padStart(7)}   ${(nv - act).toFixed(1).padStart(7)}`);
}
const w = rows.map((r) => r.w);
console.log(`\nEYE→BB slope (BB per 1 rating pt) — how steeply each SEPARATES walks by Eye:`);
console.log(`  ACTUAL ${wslope(rows.map((r) => r.eye), rows.map((r) => r.act), w).toFixed(3)}   league ${wslope(rows.map((r) => r.eye), rows.map((r) => r.lg), w).toFixed(3)}   native ${wslope(rows.map((r) => r.eye), rows.map((r) => r.nv), w).toFixed(3)}`);
console.log(`\nCalibration slope (ACTUAL BB regressed on PREDICTED BB; 1.0 = calibrated, <1 = predicts too WIDE a spread):`);
console.log(`  league ${wslope(rows.map((r) => r.lg), rows.map((r) => r.act), w).toFixed(3)}   native ${wslope(rows.map((r) => r.nv), rows.map((r) => r.act), w).toFixed(3)}`);
console.log(`\nmean BB/600:  actual ${wmean(rows.map((r) => r.act), w).toFixed(1)}   league ${wmean(rows.map((r) => r.lg), w).toFixed(1)}   native ${wmean(rows.map((r) => r.nv), w).toFixed(1)}`);
process.exit(0);
