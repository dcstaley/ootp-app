// Open Quicks — the "no-transform pooled level-bias table" (the null test).
//
// Open Quicks = Bo5 16-team FULL-pool NEUTRAL park+era (era-2010) tournaments. Because the
// pool is the full catalog and the environment is neutral, opponent-frame gaps are ~0 → any
// transform (PoolTransform / FrameShift / kSpread) is the identity. So we run the RAW model
// under a neutral park + era-2010 (all era factors = 1.0) and read predicted-vs-actual per-600
// directly. ANY residual bias here is a pure tournament-FORMAT effect (deployment / TTO),
// NOT pool-strength or era. Nothing is shifted, scaled, or opp-gap-adjusted.
//
//   run: node tools/quicks-levelbias.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights } from "../src/scoring-core/index.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park } from "../src/config/tournament.ts";

const TDIR = "Tournament Data/Quicks - Open";
const TH = 100;                         // per-card PA / BF inclusion threshold
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const thr = (x: string) => (x === "R" ? 1 : 2);
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm: EventForm = trained.eventForm;

// ── NEUTRAL environment: era-2010 (reference era, all factors 1.0) + a constructed neutral park.
const era2010 = eras.get("era-2010")!;
const neutralPark: Park = { id: "neutral", name: "neutral", avg_l: 1, avg_r: 1, hr_l: 1, hr_r: 1, gap: 1 };
const anySoftcaps = { cap_k_top: 500, cap_k_bot: 0, pen_k: 0.25, cap_babip_top: 500, cap_babip_bot: 0, pen_babip: 0.5,
  cap_gap_top: 500, cap_gap_bot: 0, pen_gap: 0.25, cap_pow_top: 500, cap_pow_bot: 0, pen_pow: 0.5 } as any;

const coeffs = resolveCoeffs(model, era2010, neutralPark, anySoftcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const rp = makeRawPolyModel(eventForm);

// era factors as sanity — everything must be ~1.0 at the reference era under a neutral park.
console.log(`\n=== era-2010 + neutral park factor sanity (expect ~1.0) ===`);
console.log(`  era_bb ${coeffs.era_bb.toFixed(4)}  era_k ${coeffs.era_k.toFixed(4)}  era_hr ${coeffs.era_hr.toFixed(4)}` +
  `  |  era_h ${derived.era_h.toFixed(4)}  era_effective_hr ${derived.era_effective_hr.toFixed(4)}  era_gap ${derived.era_gap.toFixed(4)}`);
const eBB = coeffs.era_bb, eK = coeffs.era_k, eHR = derived.era_effective_hr, eH = derived.era_h, eGAP = derived.era_gap;

// ── Aggregate per card = `${CID}|${VLvl}` across all Quicks - Open CSVs ──
interface Agg {
  r: any;
  // hitting
  hPA: number; hBB: number; hIBB: number; hK: number; hHR: number; hH: number;
  // pitching (allowed)
  pBF: number; pBB: number; pIBB: number; pK: number; pHR: number; p1B: number; p2B: number; p3B: number;
}
const m = new Map<string, Agg>();
let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0, files = 0;
for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
  files++;
  for (const r of Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
    const pa = num(r.PA), bf = num(r.BF);
    if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
    if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
    const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
    if (!a) { a = { r, hPA: 0, hBB: 0, hIBB: 0, hK: 0, hHR: 0, hH: 0, pBF: 0, pBB: 0, pIBB: 0, pK: 0, pHR: 0, p1B: 0, p2B: 0, p3B: 0 }; m.set(key, a); }
    a.hPA += pa; a.hBB += num(r.BB); a.hIBB += num(r.IBB); a.hK += num(r.K); a.hHR += num(r.HR); a.hH += num(r.H);
    a.pBF += bf; a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1); a.pK += num(r.K_1); a.pHR += num(r.HR_1);
    a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]);
  }
}
const wRhit = bfR / bfAll;                                        // hitter vR weight = league RHP share
const wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

// ── HITTER rows (raw model, neutral env) ──
interface Row { w: number; kRatBlend: number; pBB: number; aBB: number; pK: number; aK: number; pHR: number; aHR: number; pHH: number; aHH: number; }
const hitRows: Row[] = [...m.values()].filter((a) => a.hPA >= TH).map((a) => {
  const side = (s: "vR" | "vL") => rp.predictHitting({
    eye: R(a.r, s, "EYE"), pow: R(a.r, s, "POW"), kRat: R(a.r, s, "K"), babip: R(a.r, s, "BA"), gap: R(a.r, s, "GAP"),
    speed: 0, steal: 0, run: 0 }, coeffs);
  const L = side("vL"), Rr = side("vR");
  const pBB = bl(Rr.BB, L.BB, wRhit) * eBB;
  const pK = bl(Rr.SO, L.SO, wRhit) * eK;
  const pHR = bl(Rr.HR, L.HR, wRhit) * eHR;
  const pHH = bl(Rr.oneB + Rr.GAP * eGAP, L.oneB + L.GAP * eGAP, wRhit) * eH;
  const c600 = 600 / a.hPA;
  return { w: a.hPA, kRatBlend: bl(R(a.r, "vR", "K"), R(a.r, "vL", "K"), wRhit),
    pBB, aBB: (a.hBB - a.hIBB) * c600, pK, aK: a.hK * c600, pHR, aHR: a.hHR * c600, pHH, aHH: (a.hH - a.hHR) * c600 };
});

// ── PITCHER rows (raw model, neutral env) ──
const pitRows: Row[] = [...m.values()].filter((a) => a.pBF >= TH).map((a) => {
  const w = wRpit[thr(String(a.r.T))]!;
  const side = (s: "vR" | "vL") => rp.predictPitching({
    con: R(a.r, s, "CON"), stu: R(a.r, s, "STU"), pbabip: R(a.r, s, "PBABIP"), hrr: R(a.r, s, "HRA") }, coeffs);
  const L = side("vL"), Rr = side("vR");
  const pBB = bl(Rr.BB, L.BB, w) * eBB;
  const pK = bl(Rr.K, L.K, w) * eK;
  const pHR = bl(Rr.HR, L.HR, w) * eHR;
  const pHH = bl(Rr.nHH, L.nHH, w) * eH;
  const c600 = 600 / a.pBF;
  return { w: a.pBF, kRatBlend: bl(R(a.r, "vR", "STU"), R(a.r, "vL", "STU"), w),
    pBB, aBB: (a.pBB - a.pIBB) * c600, pK, aK: a.pK * c600, pHR, aHR: a.pHR * c600,
    pHH, aHH: (a.p1B + a.p2B + a.p3B) * c600 };
});

// ── Pooled level table ──
const pooled = (rows: Row[], sel: (r: Row) => { p: number; a: number }) => {
  const w = rows.map((r) => r.w);
  const p = wmean(rows.map((r) => sel(r).p), w), a = wmean(rows.map((r) => sel(r).a), w);
  return { p, a, bias: p - a };
};
const events: [string, (r: Row) => { p: number; a: number }][] = [
  ["uBB", (r) => ({ p: r.pBB, a: r.aBB })],
  ["K", (r) => ({ p: r.pK, a: r.aK })],
  ["HR", (r) => ({ p: r.pHR, a: r.aHR })],
  ["H-HR", (r) => ({ p: r.pHH, a: r.aHH })],
];
const totPA = hitRows.reduce((s, r) => s + r.w, 0), totBF = pitRows.reduce((s, r) => s + r.w, 0);
const printLevels = (label: string, rows: Row[], tot: number) => {
  console.log(`\n=== ${label} pooled predicted vs actual per 600  (N=${rows.length} cards, ${Math.round(tot).toLocaleString()} ${label === "HITTER" ? "PA" : "BF"}, threshold ${TH}) ===`);
  console.log(`  event    pred    actual    bias(pred-act)`);
  for (const [name, sel] of events) {
    const { p, a, bias } = pooled(rows, sel);
    console.log(`  ${name.padEnd(6)} ${p.toFixed(2).padStart(7)} ${a.toFixed(2).padStart(9)} ${bias.toFixed(2).padStart(12)}`);
  }
};
printLevels("HITTER", hitRows, totPA);
printLevels("PITCHER", pitRows, totBF);

// ── K-by-rating quintile slope ratio (null test for the K-separation defect) ──
// Hitters bucket by K-avoidance rating (blended K rating), pitchers by STU. Equal-count quintiles.
const quintiles = (label: string, rows: Row[]) => {
  const sorted = [...rows].sort((x, y) => x.kRatBlend - y.kRatBlend);
  const n = sorted.length, q = Math.floor(n / 5);
  const buckets: Row[][] = [];
  for (let i = 0; i < 5; i++) buckets.push(sorted.slice(i * q, i === 4 ? n : (i + 1) * q));
  console.log(`\n--- ${label} K/600 by ${label === "HITTER" ? "K-avoidance" : "STU"} rating quintile ---`);
  console.log(`  Q   n   ratingMean   predK    actK`);
  const pk: number[] = [], ak: number[] = [];
  buckets.forEach((b, i) => {
    const w = b.map((r) => r.w);
    const rm = wmean(b.map((r) => r.kRatBlend), w), p = wmean(b.map((r) => r.pK), w), a = wmean(b.map((r) => r.aK), w);
    pk.push(p); ak.push(a);
    console.log(`  Q${i + 1} ${String(b.length).padStart(3)} ${rm.toFixed(1).padStart(10)} ${p.toFixed(2).padStart(8)} ${a.toFixed(2).padStart(8)}`);
  });
  const predSpread = pk[4]! - pk[0]!, actSpread = ak[4]! - ak[0]!;
  const ratio = predSpread / actSpread;
  console.log(`  Q5-Q1 predSpread ${predSpread.toFixed(2)}  actSpread ${actSpread.toFixed(2)}  SLOPE RATIO ${ratio.toFixed(3)}`);
  return ratio;
};
console.log(`\n=== K-BY-RATING QUINTILE (slope ratio = pred Q5-Q1 spread / actual Q5-Q1 spread; in-frame expect ~1.0) ===`);
const hRatio = quintiles("HITTER", hitRows);
const pRatio = quintiles("PITCHER", pitRows);
console.log(`\n  SLOPE RATIO SUMMARY:  hitter ${hRatio.toFixed(3)}   pitcher ${pRatio.toFixed(3)}`);
console.log(`\n(files aggregated: ${files})`);
process.exit(0);
