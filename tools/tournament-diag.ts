// Diagnostics: (1) is the pool transform meaningful — reference-field vs tournament-pool rating
// strength + the actual lift applied; (2) the CON→BB (pitcher walks) vs EYE→BB (hitter walks)
// asymmetry — actual vs predicted BB by rating quintile, to see WHY one channel is biased.
//   run: node tools/tournament-diag.ts [tid] [dir]

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats, buildPoolTransform, applyAffine } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TID = process.argv[2] ?? "early-gold", TDIR = process.argv[3] ?? "Tournament Data/Early Gold", TH = 500;
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
const eventForm = trained.eventForm;
const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const rp = makeRawPolyModel(eventForm);

// ── (1) reference vs pool field strength + lift ──
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isBase = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const inVal = (c: any) => { const v = num(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
const fullBase = cat.cards.filter(isBase);
const eligBase = cat.cards.filter((c) => isBase(c) && inVal(c) && rowEligible(c as any, t));
const ref = computeUnifiedFieldStats(fullBase, coeffs, rp, 50, true);
const pool = computeUnifiedFieldStats(eligBase, coeffs, rp, 50, true);
const pt = buildPoolTransform(ref, pool, trained.ratingEnvelope ?? undefined);
console.log(`\n=== ${t.name} (${t.eraId}/${t.parkId}, value ≤${t.card_value_max}) — pool-transform diagnostic ===`);
console.log(`catalog: ${fullBase.length} base cards; eligible pool: ${eligBase.length}`);
console.log(`\ntop-50 FIELD rating means (mu):   reference (full catalog)  vs  pool (eligible)   → lift on a mid card`);
for (const [grp, keys, side] of [["HIT", ["pow", "eye", "babip"], "hit"], ["PIT", ["con", "stu", "pbabip", "hrr"], "pit"]] as const) {
  for (const k of keys) {
    const rmu = (ref as any)[side].vR[k].mu, pmu = (pool as any)[side].vR[k].mu;
    const aff = (pt as any)[side].vR[k];
    const lift = applyAffine(100, aff);
    console.log(`  ${grp} ${k.padEnd(7)} ref ${rmu.toFixed(1).padStart(6)}   pool ${pmu.toFixed(1).padStart(6)}   ratio ${(rmu / pmu).toFixed(3)}   → a raw-100 rating becomes ${lift.toFixed(1)}`);
  }
}

// ── (2) actual vs predicted BB by rating quintile (league model, RAW ratings — outcome prediction) ──
interface Agg { r: any; hPA: number; hBB: number; pBF: number; pBB: number }
const m = new Map<string, Agg>(); let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
  const pa = num(r.PA), bf = num(r.BF); if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; } if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
  const key = `${r.CID}|${r.VLvl}`; let a = m.get(key); if (!a) { a = { r, hPA: 0, hBB: 0, pBF: 0, pBB: 0 }; m.set(key, a); }
  a.hPA += pa; a.hBB += num(r.BB); a.pBF += bf; a.pBB += num(r.BB_1);
}
const wRhit = bfR / bfAll, wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
const Rr = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
const wm = (v: number[], w: number[]) => v.reduce((s, x, i) => s + x * w[i]!, 0) / w.reduce((s, x) => s + x, 0);
const hBBpred = (r: any) => bl(hittingComponents(rp.predictHitting({ eye: Rr(r, "vR", "EYE"), pow: Rr(r, "vR", "POW"), kRat: Rr(r, "vR", "K"), babip: Rr(r, "vR", "BA"), gap: Rr(r, "vR", "GAP"), speed: 0, steal: 0, run: 0 }, coeffs), 1, 1, bats(String(r.B)), "vR", coeffs, derived, eventForm).BB_fin, hittingComponents(rp.predictHitting({ eye: Rr(r, "vL", "EYE"), pow: Rr(r, "vL", "POW"), kRat: Rr(r, "vL", "K"), babip: Rr(r, "vL", "BA"), gap: Rr(r, "vL", "GAP"), speed: 0, steal: 0, run: 0 }, coeffs), 1, 1, bats(String(r.B)), "vL", coeffs, derived, eventForm).BB_fin, wRhit);
const pBBpred = (r: any) => { const w = wRpit[thr(String(r.T))]!; return bl(pitchingComponents(rp.predictPitching({ con: Rr(r, "vR", "CON"), stu: Rr(r, "vR", "STU"), pbabip: Rr(r, "vR", "PBABIP"), hrr: Rr(r, "vR", "HRA") }, coeffs), 1, 1, "vR", coeffs, derived, eventForm).BB_fin, pitchingComponents(rp.predictPitching({ con: Rr(r, "vL", "CON"), stu: Rr(r, "vL", "STU"), pbabip: Rr(r, "vL", "PBABIP"), hrr: Rr(r, "vL", "HRA") }, coeffs), 1, 1, "vL", coeffs, derived, eventForm).BB_fin, w); };

const bins = (label: string, cs: Agg[], ratOf: (a: Agg) => number, actOf: (a: Agg) => number, predOf: (a: Agg) => number, wOf: (a: Agg) => number) => {
  const sorted = [...cs].sort((a, b) => ratOf(a) - ratOf(b)), q = Math.ceil(sorted.length / 5);
  console.log(`\n${label} — BB/600 by rating quintile:`);
  console.log(`  Q   n   meanRat   ACTUAL   pred   (pred−act)`);
  for (let i = 0; i < 5; i++) { const g = sorted.slice(i * q, (i + 1) * q); if (!g.length) continue; const w = g.map(wOf); const a = wm(g.map(actOf), w), p = wm(g.map(predOf), w); console.log(`  Q${i + 1} ${String(g.length).padStart(3)}  ${wm(g.map(ratOf), w).toFixed(0).padStart(5)}   ${a.toFixed(1).padStart(6)}  ${p.toFixed(1).padStart(5)}   ${(p - a).toFixed(1).padStart(6)}`); }
};
const H = [...m.values()].filter((a) => a.hPA >= TH), P = [...m.values()].filter((a) => a.pBF >= TH);
bins(`HITTERS walks by EYE (n=${H.length})`, H, (a) => Rr(a.r, "vR", "EYE"), (a) => a.hBB * 600 / a.hPA, (a) => hBBpred(a.r), (a) => a.hPA);
bins(`PITCHERS walks-allowed by CON (n=${P.length})`, P, (a) => Rr(a.r, "vR", "CON"), (a) => a.pBB * 600 / a.pBF, (a) => pBBpred(a.r), (a) => a.pBF);
process.exit(0);
