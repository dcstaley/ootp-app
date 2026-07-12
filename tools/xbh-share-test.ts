// Throwaway analysis: is there real per-pitcher signal in XBH share of non-HR hits allowed,
// or is the model's fixed 25% share the noise ceiling?
//
//   run: node tools/xbh-share-test.ts
//
// Method: aggregate each pitcher's line per (CID, VLvl) ACROSS all 20 league files
// (both years, both sides, all leagues), threshold >= 500 BF. Variance decomposition of
// s_i = (2B+3B)/(1B+2B+3B) vs binomial expectation under a constant true share, then
// weighted correlations of the share residual against candidate drivers.
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const BF_MIN = 500;

interface Agg {
  bf: number; h1: number; h2: number; h3: number; hr: number; k: number; bb: number;
  gb: number; fb: number; // actual batted-ball counts (pitching)
  // BF-weighted rating sums (ratings can differ slightly across rows; weight-average them)
  wStu: number; wCon: number; wPbabip: number; wHra: number; wGf: number; gfW: number;
}
const m = new Map<string, Agg>();

for (const dir of ["League Files/Model 2040", "League Files/Model 2041"]) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".csv"))) {
    const rows = Papa.parse(readFileSync(`${dir}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[];
    for (const r of rows) {
      const bf = num(r.BF);
      if (bf <= 0) continue;
      const key = `${r.CID}|${r.VLvl}`;
      let a = m.get(key);
      if (!a) { a = { bf: 0, h1: 0, h2: 0, h3: 0, hr: 0, k: 0, bb: 0, gb: 0, fb: 0, wStu: 0, wCon: 0, wPbabip: 0, wHra: 0, wGf: 0, gfW: 0 }; m.set(key, a); }
      a.bf += bf;
      a.h1 += num(r["1B_2"]); a.h2 += num(r["2B_2"]); a.h3 += num(r["3B_2"]);
      a.hr += num(r["HR_1"]); a.k += num(r["K_1"]); a.bb += num(r["BB_1"]);
      a.gb += num(r.GB); a.fb += num(r["FB_1"]);
      // overall (side-agnostic) ratings since we pool vL+vR
      a.wStu += bf * num(r.STU); a.wCon += bf * num(r.CON);
      a.wPbabip += bf * num(r.PBABIP); a.wHra += bf * num(r.HRA);
      // G/F is categorical: EX GB / GB / NEU / FB / EX FB -> ordinal -2..+2 (flyball-positive)
      const GF_ORD: Record<string, number> = { "EX GB": -2, GB: -1, NEU: 0, FB: 1, "EX FB": 2 };
      const gf = GF_ORD[String(r["G/F"]).trim()];
      if (gf !== undefined) { a.wGf += bf * gf; a.gfW += bf; }
    }
  }
}

interface P { s: number; n: number; bf: number; stu: number; con: number; pbabip: number; hra: number; gf: number | null; gbfbAct: number | null }
const ps: P[] = [];
for (const a of m.values()) {
  if (a.bf < BF_MIN) continue;
  const n = a.h1 + a.h2 + a.h3;
  if (n < 10) continue; // guard degenerate shares
  ps.push({
    s: (a.h2 + a.h3) / n, n, bf: a.bf,
    stu: a.wStu / a.bf, con: a.wCon / a.bf, pbabip: a.wPbabip / a.bf, hra: a.wHra / a.bf,
    gf: a.gfW > 0 ? a.wGf / a.gfW : null,
    gbfbAct: a.gb + a.fb > 0 ? a.gb / (a.gb + a.fb) : null,
  });
}
console.log(`pitchers at >=${BF_MIN} BF (aggregated per CID|VLvl across ${m.size} keyed lines): ${ps.length}`);

// ---- overall league mean share (pooled counts) ----
const totXbh = ps.reduce((t, p) => t + p.s * p.n, 0);
const totN = ps.reduce((t, p) => t + p.n, 0);
const sBar = totXbh / totN;
console.log(`\nleague mean XBH share s_bar = ${sBar.toFixed(4)}   (model hard-codes 0.25)`);
console.log(`total non-HR hits pooled: ${totN}   mean hits/pitcher: ${(totN / ps.length).toFixed(0)}`);

// ---- variance decomposition (weighted two ways: by n_i and by BF) ----
function decomp(wOf: (p: P) => number, label: string) {
  const W = ps.reduce((t, p) => t + wOf(p), 0);
  const mean = ps.reduce((t, p) => t + wOf(p) * p.s, 0) / W;
  const obsVar = ps.reduce((t, p) => t + wOf(p) * (p.s - mean) ** 2, 0) / W;
  const expVar = ps.reduce((t, p) => t + wOf(p) * (sBar * (1 - sBar)) / p.n, 0) / W;
  const excess = obsVar - expVar;
  const sigSD = excess > 0 ? Math.sqrt(excess) : 0;
  console.log(`\n[${label}] mean=${mean.toFixed(4)}  obsVar=${obsVar.toExponential(3)}  binomVar=${expVar.toExponential(3)}  ratio=${(obsVar / expVar).toFixed(3)}`);
  console.log(`  implied true-signal SD = ${(sigSD * 100).toFixed(2)} share points  (obs SD=${(Math.sqrt(obsVar) * 100).toFixed(2)}, noise SD=${(Math.sqrt(expVar) * 100).toFixed(2)})`);
  return { mean, obsVar, expVar, sigSD };
}
const dN = decomp((p) => p.n, "weighted by n_i (non-HR hits)");
decomp((p) => p.bf, "weighted by BF");

// implied max correlation a perfect share model could reach against per-pitcher observed share
const rCeil = Math.sqrt(Math.max(0, dN.obsVar - dN.expVar) / dN.obsVar);
console.log(`\nmax attainable corr of ANY share model vs observed per-pitcher share (this sample): ${rCeil.toFixed(3)}`);

// ---- weighted Pearson of share residual vs candidate drivers ----
function wPearson(pairs: Array<[number, number, number]>): number {
  const W = pairs.reduce((t, q) => t + q[2], 0);
  const mx = pairs.reduce((t, q) => t + q[2] * q[0], 0) / W;
  const my = pairs.reduce((t, q) => t + q[2] * q[1], 0) / W;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y, w] of pairs) { sxx += w * (x - mx) ** 2; syy += w * (y - my) ** 2; sxy += w * (x - mx) * (y - my); }
  return sxy / Math.sqrt(sxx * syy);
}
console.log(`\n=== weighted Pearson: (s_i - s_bar) vs drivers (weight = n_i) ===`);
const drivers: Array<[string, (p: P) => number | null]> = [
  ["G/F rating col", (p) => p.gf],
  ["actual GB/(GB+FB)", (p) => p.gbfbAct],
  ["STU", (p) => p.stu],
  ["CON", (p) => p.con],
  ["PBABIP", (p) => p.pbabip],
  ["HRA", (p) => p.hra],
];
for (const [name, get] of drivers) {
  const pairs = ps.flatMap((p): Array<[number, number, number]> => {
    const v = get(p);
    return v == null || !Number.isFinite(v) ? [] : [[v, p.s - sBar, p.n]];
  });
  console.log(`  ${name.padEnd(18)} r=${wPearson(pairs).toFixed(3).padStart(7)}   (n=${pairs.length})`);
}

// quintile view for the strongest structural candidate: actual GB share
const withGb = ps.filter((p) => p.gbfbAct != null).sort((a, b) => a.gbfbAct! - b.gbfbAct!);
if (withGb.length > 20) {
  console.log(`\n  XBH share by actual-GB-share quintile:`);
  const q = Math.floor(withGb.length / 5);
  for (let i = 0; i < 5; i++) {
    const grp = withGb.slice(i * q, i === 4 ? withGb.length : (i + 1) * q);
    const N = grp.reduce((t, p) => t + p.n, 0);
    const sh = grp.reduce((t, p) => t + p.s * p.n, 0) / N;
    const gbm = grp.reduce((t, p) => t + p.gbfbAct! * p.n, 0) / N;
    console.log(`    Q${i + 1}: GB%=${(gbm * 100).toFixed(1)}  XBH share=${sh.toFixed(4)}  (pitchers=${grp.length})`);
  }
}

// ---- tournament-era sanity: pooled s_bar in Early Gold / Return of the Bronze ----
console.log(`\n=== tournament pooled XBH share (era check) ===`);
for (const tdir of ["Tournament Data/Early Gold", "Tournament Data/Return of the Bronze"]) {
  let x1 = 0, x2 = 0, x3 = 0;
  for (const f of readdirSync(tdir).filter((x) => x.endsWith(".csv"))) {
    const rows = Papa.parse(readFileSync(`${tdir}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[];
    for (const r of rows) { x1 += num(r["1B_2"]); x2 += num(r["2B_2"]); x3 += num(r["3B_2"]); }
  }
  const n = x1 + x2 + x3;
  console.log(`  ${tdir.split("/")[1]!.padEnd(22)} s_bar=${(n ? (x2 + x3) / n : NaN).toFixed(4)}  (1B=${x1} 2B=${x2} 3B=${x3})`);
}
