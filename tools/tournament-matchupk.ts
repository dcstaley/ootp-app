// Off-frame validation for the woba·matchupK bake-off candidate (plan §10.3: the K channel
// under-separates ~55–70% on BOTH roles in tournament pools after level correction).
//
// League side: fits the DEPLOYED forms (RAWPOLY_HIT / STUFFAUG_PIT) and the matchup-K hybrids
// on the league window (availableYears("League Files").slice(-2)) and reports the scoreboard
// rows (in-sample / CV / OOT, wOBA space) plus a K-channel-only league CV per role.
//
// Tournament side (the decision evidence): per tournament + role, a K-by-rating quintile table —
//   ACTUAL        observed K/600 (≥500 PA/BF, exposure-blended vR/vL ratings)
//   DEP+gap       deployed K curve with the additive opponent-gap level shift on the K input
//                 (kRat + (μ_stu_league − μ_stu_pool); stu + (μ_kRat_league − μ_kRat_pool))
//   MATCHUP       the joint curve evaluated in the POOL frame — the stored league opponent mean
//                 swapped for the tournament pool's own PA/BF-weighted opponent mean (that IS
//                 the matchup model's native frame correction; no other transform)
// and the K slope ratio (predicted Q5−Q1 spread / actual) — success = MATCHUP moves it toward
// 1.0 from the ~0.55–0.70 deployed baseline without costing league accuracy.
// Both prediction columns are scaled by the tournament era's K factor (same factor both models).
//
//   run: node tools/tournament-matchupk.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { crossValidate, inSample, outOfTime, foldOf, cvFoldKey } from "../src/training/evaluate.ts";
import { HITTER, PITCHER, type BakeoffModel, type RoleSpec } from "../src/training/bakeoff.ts";
import {
  FORM_ENTRIES, RAWPOLY_HIT, STUFFAUG_PIT, hitFormModel, pitFormModel,
  fitHitForm, fitPitForm, fitHitMatchup, fitPitMatchup, matchupHitK, matchupPitK,
  type FittedHit, type FittedPit,
} from "../src/training/forms.ts";
import { rate } from "../src/model/curves.ts";
import { wPearson } from "../src/training/metrics.ts";
import type { EvalMetrics } from "../src/training/metrics.ts";

const ROOT = "League Files";
const MINN = 1000, TH = Number(process.env.TH ?? 500);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const thr = (x: string) => (x === "R" ? 1 : 2);
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);
const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

// ── 1. League fits ───────────────────────────────────────────────────────────────
const years = availableYears(ROOT);
const window = years.slice(-2);
const { observations } = loadWindow(ROOT, window);
const hitQ = observations.filter((o) => o.hit.PA >= MINN);
const pitQ = observations.filter((o) => o.pitch.BF >= MINN);
console.log(`league window ${window.join("+")}  hitters ${hitQ.length}  pitchers ${pitQ.length}  (minN ${MINN})`);

const depHit = fitHitForm(RAWPOLY_HIT, hitQ);
const depPit = fitPitForm(STUFFAUG_PIT, pitQ);
const mkHit = fitHitMatchup(hitQ, pitQ);
const mkPit = fitPitMatchup(pitQ, hitQ);
const mk = mkHit.mk; // same joint fit both directions (identical inputs)
console.log(`stored league frame: muStu(BF-wt) ${mk.muStu.toFixed(1)}  muKRat(PA-wt) ${mk.muKRat.toFixed(1)}  f beta=[${mk.f.beta.map((b) => b.toFixed(2)).join(", ")}]`);

// ── 2. League scoreboard rows (wOBA space) for the 4 models ─────────────────────
const matchupModels = FORM_ENTRIES.filter((e) => e.model.name === "woba·matchupK");
const board: { model: BakeoffModel; spec: RoleSpec }[] = [
  { model: hitFormModel(RAWPOLY_HIT), spec: HITTER },
  { model: matchupModels.find((e) => e.spec.role === "hitter")!.model, spec: HITTER },
  { model: pitFormModel(STUFFAUG_PIT), spec: PITCHER },
  { model: matchupModels.find((e) => e.spec.role === "pitcher")!.model, spec: PITCHER },
];
// OOT blocks — same logic as buildScoreboard (leading distant-past block / trailing future block).
const wMin = Math.min(...window), wMax = Math.max(...window);
const backTest: number[] = [];
for (let i = 0; i < years.length && years[i]! < wMin; i++) { if (i > 0 && years[i]! - years[i - 1]! > 2) break; backTest.push(years[i]!); }
const fwdTest: number[] = [];
for (let i = years.length - 1; i >= 0 && years[i]! > wMax; i--) { if (i < years.length - 1 && years[i + 1]! - years[i]! > 2) break; fwdTest.unshift(years[i]!); }
const backObs = backTest.length ? loadWindow(ROOT, backTest).observations : [];
const fwdObs = fwdTest.length ? loadWindow(ROOT, fwdTest).observations : [];

const fmt = (m: EvalMetrics) => `pearson ${m.pearson.toFixed(3)}  spearman ${m.spearman.toFixed(3)}  gapRmse ${(m.gapRmse * 1000).toFixed(2)}  rmse ${(m.rmse * 1000).toFixed(2)}  top26 ${(m.topNOverlap * 100).toFixed(0)}%  regret ${(m.valueRegret * 1000).toFixed(2)}  n ${m.n}`;
console.log(`\n=== League scoreboard rows (wOBA space; gapRmse/rmse/regret ×1000) ===`);
for (const { model, spec } of board) {
  console.log(`  ${model.name} · ${spec.role}`);
  console.log(`    in-sample  ${fmt(inSample(observations, model, spec, { minN: MINN }))}`);
  console.log(`    cv         ${fmt(crossValidate(observations, model, spec, { minN: MINN }))}`);
  if (fwdTest.length) console.log(`    forward →${fwdTest.join(",")}  ${fmt(outOfTime(observations, fwdObs, model, spec, { minN: MINN }))}`);
  if (backTest.length) console.log(`    backward →${backTest.join(",")}  ${fmt(outOfTime(observations, backObs, model, spec, { minN: MINN }))}`);
}

// ── 3. League K-channel-only CV (does the shared curve cost in-frame K accuracy?) ─
console.log(`\n=== League K-channel 5-fold CV (K/600; pooled out-of-fold predictions) ===`);
for (const role of ["hitter", "pitcher"] as const) {
  const qual = role === "hitter" ? hitQ : pitQ;
  const opp = role === "hitter" ? pitQ : hitQ;
  const pred: { dep: number[]; mk: number[] } = { dep: [], mk: [] };
  const act: number[] = [], w: number[] = [];
  for (let f = 0; f < 5; f++) {
    const test = qual.filter((o) => foldOf(cvFoldKey(o), 5) === f);
    const train = qual.filter((o) => foldOf(cvFoldKey(o), 5) !== f);
    const oppTr = opp.filter((o) => foldOf(cvFoldKey(o), 5) !== f);
    if (!test.length || train.length < 10) continue;
    if (role === "hitter") {
      const d = fitHitForm(RAWPOLY_HIT, train), m = fitHitMatchup(train, oppTr);
      for (const o of test) { pred.dep.push(rate(d.k, o.ratings.hit.kRat)); pred.mk.push(matchupHitK(m.mk, o.ratings.hit.kRat)); act.push((o.hit.K / Math.max(o.hit.PA, 1)) * 600); w.push(Math.pow(o.hit.PA, 0.75)); }
    } else {
      const d = fitPitForm(STUFFAUG_PIT, train), m = fitPitMatchup(train, oppTr);
      for (const o of test) { pred.dep.push(rate(d.k, o.ratings.pitch.stu)); pred.mk.push(matchupPitK(m.mk, o.ratings.pitch.stu)); act.push((o.pitch.K / Math.max(o.pitch.BF, 1)) * 600); w.push(Math.pow(o.pitch.BF, 0.75)); }
    }
  }
  const line = (name: string, p: number[]) => {
    const rmse = Math.sqrt(wmean(p.map((v, i) => (v - act[i]!) ** 2), w));
    console.log(`  ${role.padEnd(8)} ${name.padEnd(8)} pearson ${wPearson(p, act, w).toFixed(4)}  rmse ${rmse.toFixed(2)}  bias ${wmean(p.map((v, i) => v - act[i]!), w).toFixed(2)}`);
  };
  line("deployed", pred.dep); line("matchupK", pred.mk);
}

// ── 4. Tournament off-frame quintile tables ──────────────────────────────────────
interface Agg { r: Record<string, string>; hPA: number; hK: number; pBF: number; pK: number }
const R = (r: Record<string, string>, s: string, c: string) => num(r[`${c} ${s}`]);

function runTournament(name: string, dir: string, tid: string) {
  const t = JSON.parse(readFileSync(`data/tournaments/${tid}.json`, "utf8"));
  const era = JSON.parse(readFileSync(`data/eras/${t.eraId}.json`, "utf8"));
  const eraK = num(era.k) || 1;

  const m = new Map<string, Agg>();
  let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".csv"))) {
    for (const r of Papa.parse(readFileSync(`${dir}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as Record<string, string>[]) {
      const pa = num(r.PA), bf = num(r.BF);
      if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
      if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
      const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
      if (!a) { a = { r, hPA: 0, hK: 0, pBF: 0, pK: 0 }; m.set(key, a); }
      a.hPA += pa; a.hK += num(r.K); a.pBF += bf; a.pK += num(r.K_1);
    }
  }
  const wRhit = bfR / bfAll;
  const wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
  const cards = [...m.values()];

  // Pool-side opponent means from the tournament's OWN ratings, PA/BF-weighted.
  const pitAll = cards.filter((a) => a.pBF > 0);
  const hitAll = cards.filter((a) => a.hPA > 0);
  const stuOf = (a: Agg) => bl(R(a.r, "vR", "STU"), R(a.r, "vL", "STU"), wRpit[thr(String(a.r.T))]!);
  const kROf = (a: Agg) => bl(R(a.r, "vR", "K"), R(a.r, "vL", "K"), wRhit);
  const muStuPool = wmean(pitAll.map(stuOf), pitAll.map((a) => a.pBF));
  const muKPool = wmean(hitAll.map(kROf), hitAll.map((a) => a.hPA));
  const gapStu = mk.muStu - muStuPool, gapK = mk.muKRat - muKPool;
  console.log(`\n===== ${name} (${tid}, era ${t.eraId}, era_k ${eraK.toFixed(3)}) =====`);
  console.log(`pool opp means: muStu ${muStuPool.toFixed(1)} (league ${mk.muStu.toFixed(1)}, gap ${gapStu.toFixed(1)})  muKRat ${muKPool.toFixed(1)} (league ${mk.muKRat.toFixed(1)}, gap ${gapK.toFixed(1)})`);

  for (const role of ["hitter", "pitcher"] as const) {
    const cs = cards.filter((a) => (role === "hitter" ? a.hPA : a.pBF) >= TH);
    const rows = cs.map((a) => {
      const w = role === "hitter" ? a.hPA : a.pBF;
      const act = (role === "hitter" ? a.hK / a.hPA : a.pK / a.pBF) * 600;
      let ratg: number, dep: number, mku: number;
      if (role === "hitter") {
        const side = (s: "vR" | "vL") => ({ dep: rate(depHit.k, R(a.r, s, "K") + gapStu), mk: matchupHitK(mk, R(a.r, s, "K"), muStuPool) });
        const A = side("vR"), B = side("vL");
        ratg = kROf(a); dep = bl(A.dep, B.dep, wRhit) * eraK; mku = bl(A.mk, B.mk, wRhit) * eraK;
      } else {
        const wR = wRpit[thr(String(a.r.T))]!;
        const side = (s: "vR" | "vL") => ({ dep: rate(depPit.k, R(a.r, s, "STU") + gapK), mk: matchupPitK(mk, R(a.r, s, "STU"), muKPool) });
        const A = side("vR"), B = side("vL");
        ratg = stuOf(a); dep = bl(A.dep, B.dep, wR) * eraK; mku = bl(A.mk, B.mk, wR) * eraK;
      }
      return { ratg, w, act, dep, mku };
    }).sort((x, y) => x.ratg - y.ratg);

    const ratName = role === "hitter" ? "kRat" : "STU";
    console.log(`\n--- ${role.toUpperCase()} K/600 by ${ratName} quintile (n=${rows.length} at >=${TH} ${role === "hitter" ? "PA" : "BF"}) ---`);
    console.log(`  quint  mean${ratName.padEnd(5)}  ACTUAL  DEP+gap (bias)  MATCHUP (bias)`);
    const q = Math.ceil(rows.length / 5);
    const qm: { act: number; dep: number; mku: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const g = rows.slice(i * q, (i + 1) * q); if (!g.length) continue;
      const w = g.map((x) => x.w);
      const act = wmean(g.map((x) => x.act), w), dep = wmean(g.map((x) => x.dep), w), mku = wmean(g.map((x) => x.mku), w);
      qm.push({ act, dep, mku });
      console.log(`  Q${i + 1}   ${wmean(g.map((x) => x.ratg), w).toFixed(0).padStart(6)}  ${act.toFixed(1).padStart(7)} ${dep.toFixed(1).padStart(7)} (${(dep - act >= 0 ? "+" : "")}${(dep - act).toFixed(1)})  ${mku.toFixed(1).padStart(7)} (${(mku - act >= 0 ? "+" : "")}${(mku - act).toFixed(1)})`);
    }
    const spread = (f: (x: { act: number; dep: number; mku: number }) => number) => f(qm[qm.length - 1]!) - f(qm[0]!);
    const sAct = spread((x) => x.act);
    console.log(`  K slope ratio (pred spread / actual, Q${qm.length}−Q1):  DEP+gap ${(spread((x) => x.dep) / sAct).toFixed(2)}   MATCHUP ${(spread((x) => x.mku) / sAct).toFixed(2)}`);
  }
}

runTournament("Early Gold", "Tournament Data/Early Gold", "early-gold");
runTournament("Return of the Bronze", "Tournament Data/Return of the Bronze", "bronze-return");
process.exit(0);
