// THROWAWAY DIAGNOSTIC (2026-07-20) — pit.hr quad turn-over on window [2042,2043].
// Reuses the EXACT trainer path: loadWindow → filter PITCHER.qualifies(minPA=1000) →
// fitPitForm(PARETO_PIT) — same as server.saveTrainedModel. No production code changed.
import { loadWindow, loadWindowLeagues, type TrainObs } from "../src/training/loader.ts";
import { fitPitForm, pitFormModel, PARETO_PIT, type PitForm } from "../src/training/forms.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { inSample, crossValidate } from "../src/training/evaluate.ts";
import { inDomainVertex, rateAux, rateRaw, LOG, type Curve } from "../src/model/curves.ts";

const ROOT = "League Files";
const MINPA = 1000;
const Q2: Curve = { kind: "rawpoly", degree: 2 };
// PARETO with ONLY the hr channel dropped to the log baseline (the guard's named remedy).
const HRLOG_PIT: PitForm = { name: "woba·pareto-hrlog", bb: LOG, k: Q2, hr: LOG, h: Q2, stuffAug: true };

const f = (x: number, d = 4) => x.toFixed(d);

// ── 1. DATA SANITY: per (league, year, side) row counts + totals + league HR rates ──
console.log("=== 1. DATA SANITY: 2042 vs 2043 per league/side ===");
const LEAGUES = ["PEL", "HD450", "HD451", "HD452", "HD453"];
for (const lg of LEAGUES) {
  for (const yr of [2042, 2043]) {
    const lt = loadWindowLeagues(ROOT, [yr], [lg]);
    if (lt.summary.unparsedFiles.length) console.log(`  !! unparsed: ${lt.summary.unparsedFiles.join(", ")}`);
    if (lt.summary.excludedCells.length) console.log(`  !! excluded cells: ${lt.summary.excludedCells.join(", ")}`);
    for (const side of ["L", "R"] as const) {
      const cell = lt.summary.cells.find((c) => c.side === side);
      const so = lt.observations.filter((o) => o.side === side);
      const hPA = so.reduce((s, o) => s + o.hit.PA, 0), hHR = so.reduce((s, o) => s + o.hit.HR, 0);
      const pBF = so.reduce((s, o) => s + o.pitch.BF, 0), pHR = so.reduce((s, o) => s + o.pitch.HR, 0);
      console.log(
        `${lg} ${yr} v${side}: rows=${cell?.rows ?? "??"} PA=${hPA} BF=${pBF}` +
        ` hitHR/600PA=${f((hHR / Math.max(hPA, 1)) * 600, 2)} pitHR/600BF=${f((pHR / Math.max(pBF, 1)) * 600, 2)}`
      );
    }
  }
}
// Loader-level anomalies over the joint window
for (const win of [[2042], [2043], [2042, 2043]]) {
  const lt = loadWindow(ROOT, win);
  console.log(`window [${win}]: files=${lt.summary.files.length} unparsed=[${lt.summary.unparsedFiles}] excluded=[${lt.summary.excludedCells}] obs=${lt.summary.observations} pitObs=${lt.summary.pitcherObs} totalBF=${lt.summary.totalBF}`);
}

// ── 2. FIT COMPARISON across windows ──
console.log("\n=== 2. pit.hr FIT ACROSS WINDOWS (quad = PARETO_PIT exactly as trainer) ===");
const WINDOWS: number[][] = [[2041, 2042], [2042, 2043], [2043], [2042], [2041, 2042, 2043]];
interface WinResult { win: number[]; obs: TrainObs[]; qual: TrainObs[]; quad: ReturnType<typeof fitPitForm>; log: ReturnType<typeof fitPitForm> }
const results: WinResult[] = [];
for (const win of WINDOWS) {
  const obs = loadWindow(ROOT, win).observations; // includeVariants=true (trainer default)
  const qual = obs.filter((o) => PITCHER.qualifies(o, MINPA));
  const quad = fitPitForm(PARETO_PIT, qual);
  const log = fitPitForm(HRLOG_PIT, qual);
  results.push({ win, obs, qual, quad, log });

  const hr = quad.hr;
  const b1 = hr.beta[1] ?? 0, b2 = hr.beta[2] ?? 0;
  const vertex = Math.abs(b2) < 1e-12 ? null : -b1 / (2 * b2);
  const inDom = inDomainVertex(hr); // the ACTUAL guard predicate
  console.log(`\n--- window [${win.join(",")}]  pitQual n=${qual.length} ---`);
  console.log(`  quad beta=[${hr.beta.map((b) => f(b, 4)).join(", ")}] aux(stu)beta=${f(hr.aux?.beta ?? 0, 4)}`);
  console.log(`  hrr mu=${f(hr.mu, 2)} sd=${f(hr.sd, 2)} domain z=[${f(hr.uMin!, 3)}, ${f(hr.uMax!, 3)}]`);
  console.log(`  vertex z=${vertex == null ? "none" : f(vertex, 3)}  GUARD FIRES=${inDom != null}${inDom != null ? ` (inDomainVertex=${f(inDom, 3)})` : ""}`);
  console.log(`  log  beta=[${log.hr.beta.map((b) => f(b, 4)).join(", ")}] aux(stu)beta=${f(log.hr.aux?.beta ?? 0, 4)}`);

  // Bake-off comparison metric (the harness the scoreboard/gates use): weighted Pearson
  // headline + spearman, in-sample and 5-fold CV, whole pitcher model quad-hr vs log-hr.
  const mQ = pitFormModel(PARETO_PIT), mL = pitFormModel(HRLOG_PIT);
  const isQ = inSample(obs, mQ, PITCHER, { minN: MINPA });
  const isL = inSample(obs, mL, PITCHER, { minN: MINPA });
  const cvQ = crossValidate(obs, mQ, PITCHER, { minN: MINPA });
  const cvL = crossValidate(obs, mL, PITCHER, { minN: MINPA });
  console.log(`  metric (wPearson/spearman):  quad in-sample ${f(isQ.pearson)}/${f(isQ.spearman)}  cv ${f(cvQ.pearson)}/${f(cvQ.spearman)}`);
  console.log(`                               log  in-sample ${f(isL.pearson)}/${f(isL.spearman)}  cv ${f(cvL.pearson)}/${f(cvL.spearman)}`);

  // HR-channel per-600 predicted spread across the qualifying pool (deployed eval incl. aux+cap).
  const predQ = qual.map((o) => rateAux(quad.hr, o.ratings.pitch.hrr, o.ratings.pitch.stu));
  const predL = qual.map((o) => rateAux(log.hr, o.ratings.pitch.hrr, o.ratings.pitch.stu));
  const sd = (xs: number[]) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };
  console.log(`  HR-channel pred SD (per600): quad=${f(sd(predQ), 3)} log=${f(sd(predL), 3)} (log/quad=${f(sd(predL) / sd(predQ), 3)})`);
}

// ── 3. TAIL FORENSICS on [2042,2043] ──
console.log("\n=== 3. TAIL FORENSICS [2042,2043] ===");
const R = results.find((r) => r.win.length === 2 && r.win[0] === 2042)!;
const hrQ = R.quad.hr, hrL = R.log.hr;
const z = (o: TrainObs) => (o.ratings.pitch.hrr - hrQ.mu) / hrQ.sd;
const tail = R.qual.filter((o) => z(o) > 2.0);
const b1 = hrQ.beta[1] ?? 0, b2 = hrQ.beta[2] ?? 0, vz = -b1 / (2 * b2);
console.log(`qualifying pitcher obs: ${R.qual.length}; z(pHR) > 2.0: ${tail.length}; beyond vertex z=${f(vz, 3)}: ${R.qual.filter((o) => z(o) > vz).length}`);
const tailBF = tail.reduce((s, o) => s + o.pitch.BF, 0);
console.log(`tail total BF=${tailBF} (share of qual BF: ${f(tailBF / R.qual.reduce((s, o) => s + o.pitch.BF, 0) * 100, 2)}%)`);
const top = [...R.qual].sort((a, b) => b.ratings.pitch.hrr - a.ratings.pitch.hrr).slice(0, 15);
console.log("top 15 by pHR rating (HRA):");
console.log("  name                      side var  hrr    z     BF   obsHR/600  quadPred  quadRaw  logPred  years");
for (const o of top) {
  const obs600 = (o.pitch.HR / Math.max(o.pitch.BF, 1)) * 600;
  const q = rateAux(hrQ, o.ratings.pitch.hrr, o.ratings.pitch.stu);   // deployed eval (cap + aux)
  const qr = rateRaw(hrQ, o.ratings.pitch.hrr);                        // uncapped quad, no aux
  const l = rateAux(hrL, o.ratings.pitch.hrr, o.ratings.pitch.stu);
  const yrs = [...new Set(o.sources.filter((s) => s.bf > 0).map((s) => s.year))].join("+");
  console.log(`  ${o.name.padEnd(25)} ${o.side}   ${o.variant ? "V" : "B"}  ${String(o.ratings.pitch.hrr).padStart(4)} ${f(z(o), 2).padStart(5)} ${String(o.pitch.BF).padStart(6)}  ${f(obs600, 2).padStart(8)}  ${f(q, 2).padStart(8)} ${f(qr, 2).padStart(8)} ${f(l, 2).padStart(8)}  ${yrs}`);
}
// Binned observed HR/600 by z, to see whether the tail really flattens/rises
console.log("binned observed HR/600BF by z (BF-weighted), [2042,2043] qual pool:");
const bins: [number, number][] = [[-9, -1.5], [-1.5, -1], [-1, -0.5], [-0.5, 0], [0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 9]];
for (const [lo, hi] of bins) {
  const g = R.qual.filter((o) => z(o) > lo && z(o) <= hi);
  if (!g.length) continue;
  const bf = g.reduce((s, o) => s + o.pitch.BF, 0), hr = g.reduce((s, o) => s + o.pitch.HR, 0);
  console.log(`  z(${String(lo).padStart(4)},${String(hi).padStart(4)}]: n=${String(g.length).padStart(4)} BF=${String(bf).padStart(8)} obsHR/600=${f((hr / Math.max(bf, 1)) * 600, 2)}`);
}
console.log("\nsame bins on [2041,2042] (deployed window) for contrast:");
const R0 = results.find((r) => r.win[0] === 2041 && r.win.length === 2)!;
const hrQ0 = R0.quad.hr;
const z0 = (o: TrainObs) => (o.ratings.pitch.hrr - hrQ0.mu) / hrQ0.sd;
for (const [lo, hi] of bins) {
  const g = R0.qual.filter((o) => z0(o) > lo && z0(o) <= hi);
  if (!g.length) continue;
  const bf = g.reduce((s, o) => s + o.pitch.BF, 0), hr = g.reduce((s, o) => s + o.pitch.HR, 0);
  console.log(`  z(${String(lo).padStart(4)},${String(hi).padStart(4)}]: n=${String(g.length).padStart(4)} BF=${String(bf).padStart(8)} obsHR/600=${f((hr / Math.max(bf, 1)) * 600, 2)}`);
}
