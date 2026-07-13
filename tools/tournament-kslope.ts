// K-channel spread recalibration — the "frame correction v2" experiment.
// After the additive opponent-gap shift fixes LEVELS, the K channel still under-separates
// (predicted spread ≈ 0.4–0.6 of actual, both roles, both tournaments; league in-frame = 1.0).
// Mechanism under test: per-role spread scaling around the pool mean,
//     K_corr(card) = K̄_pool + s · (K_pred(card) − K̄_pool)
// with s → 1 as the frame gap → 0. Parameterizations tried (fit on one tournament,
// validate on the other — cross-era):
//   P0: s = constant (weak-pool flat)         P1: s = 1 + β·gap (linear in own-channel gap)
// Also fits the pitcher-BB LEVEL residual as a gap-proportional shift multiplier λ:
//     con_eff = con + λ·oppGap_eye   (λ=1 ⇒ the plain opp-gap shift)
//
//   run: node tools/tournament-kslope.ts
//
import Papa from "papaparse";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { computeDerived, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const TH = 500;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const thr = (x: string) => (x === "R" ? 1 : 2);
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm: EventForm = trained.eventForm;
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";

// ── FRAME-V2 REFERENCE: the model's TRAINING-opponent means (PA/BF-weighted, pooled over
// sides) — mirrors saveTrainedModel's persisted `trainingMeans` EXACTLY, so the re-fit here
// predicts production frame-v2 behavior. This SUPERSEDES the old catalog-top-50 `refF` base
// (which mis-based the opp-gap by up to +16 on hit.eye → the "pitcher-BB flat offset"). §10.8.
const TRAINING_DIR = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d)) ?? "League Files";
const trWindow: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const trained_obs = loadWindow(TRAINING_DIR, trWindow.length ? trWindow : undefined).observations
  .filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const hqTr = trained_obs.filter((o) => HITTER.qualifies(o, minPA));
const pqTr = trained_obs.filter((o) => PITCHER.qualifies(o, minPA));
const paOf = (o: TrainObs) => o.sources.reduce((s, x) => s + x.pa, 0);
const bfOf = (o: TrainObs) => o.sources.reduce((s, x) => s + x.bf, 0);
const wm = (rows: TrainObs[], w: (o: TrainObs) => number, get: (o: TrainObs) => number) => {
  let nn = 0, dd = 0; for (const o of rows) { const t = w(o); nn += t * get(o); dd += t; } return dd ? nn / dd : 0;
};
// USAGE-weighted recompute — kept ONLY as a diagnostic contrast; NOT the production frame.
const TM_usage = {
  hit: { eye: wm(hqTr, paOf, (o) => o.ratings.hit.eye), pow: wm(hqTr, paOf, (o) => o.ratings.hit.pow), kRat: wm(hqTr, paOf, (o) => o.ratings.hit.kRat), babip: wm(hqTr, paOf, (o) => o.ratings.hit.babip), gap: wm(hqTr, paOf, (o) => o.ratings.hit.gap) },
  pit: { con: wm(pqTr, bfOf, (o) => o.ratings.pitch.con), stu: wm(pqTr, bfOf, (o) => o.ratings.pitch.stu), pbabip: wm(pqTr, bfOf, (o) => o.ratings.pitch.pbabip), hrr: wm(pqTr, bfOf, (o) => o.ratings.pitch.hrr) },
};
// PRODUCTION FRAME: read trainingMeans STRAIGHT OFF THE ARTIFACT (matched-legs = top-50 of the
// training league, f88912c). The old code re-derived usage-weighted means here — a DIFFERENT frame
// than production applies (audit item 5). Fall back to the usage recompute only if the artifact
// lacks them (pre-f88912c), and flag it.
const artTM = trained.trainingMeans;
const TM = artTM ?? TM_usage;
console.log(`\n=== trainingMeans (source: ${artTM ? "ARTIFACT (matched-legs top-50)" : "USAGE-WEIGHTED FALLBACK — artifact lacks trainingMeans!"}) ===`);
console.log(`  hit: eye ${TM.hit.eye.toFixed(1)}  pow ${TM.hit.pow.toFixed(1)}  kRat ${TM.hit.kRat.toFixed(1)}  babip ${TM.hit.babip.toFixed(1)}  gap ${TM.hit.gap.toFixed(1)}`);
console.log(`  pit: con ${TM.pit.con.toFixed(1)}  stu ${TM.pit.stu.toFixed(1)}  pbabip ${TM.pit.pbabip.toFixed(1)}  hrr ${TM.pit.hrr.toFixed(1)}`);
if (artTM) console.log(`  (usage-weighted contrast: hit.eye ${TM_usage.hit.eye.toFixed(1)}  pit.stu ${TM_usage.pit.stu.toFixed(1)} — artifact−usage tells the mis-basing sign)`);

interface TCase {
  name: string; role: "hit" | "pit";
  gapOwn: number;            // own K-channel gap (hit: kRat; pit: stu)
  kbar: number;              // production K̄_pool (poolMeanK top-50 field) — the s* centering point
  rows: { w: number; act: number; pred: number; rat: number }[]; // per-card K/600 (post opp-gap level shift)
  bbRows?: { w: number; act: number; base: number; con: number; eyeGap: number }[]; // pitcher uBB rows
}
const cases: TCase[] = [];

// One source of truth: read the RAW dir and ghost-clean each file IN-MEMORY via cleanTournamentRows
// (the deterministic detector that reproduced the retired "- CLEANED" mirror exactly).
for (const [name, TDIR, TID] of [["EG", "Tournament Data/Early Gold", "early-gold"], ["BR", "Tournament Data/Return of the Bronze", "bronze-return"]] as const) {
  console.log(`[${name}] data dir: ${TDIR} (RAW — ghost-cleaned in-memory)`);
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  computeDerived(coeffs, true);
  const rp = makeRawPolyModel(eventForm);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const refF = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, 50, true);
  const basePool = cat.cards.filter((c) => isB(c) && inV(c) && rowEligible(c as any, t));
  const poolF = computeUnifiedFieldStats(basePool, coeffs, rp, 50, true);
  // K̄_pool EXACTLY as production centers it (poolMeanK = top-50 field mean on frame-shifted
  // ratings), NOT the PA-weighted participant mean the old s* fit used (audit item 6). The s* fit
  // below centers deviations on this, so the fit matches production — never the reverse.
  const fs = buildFrameShift(TM as any, poolF);
  // poolMeanK returns PRE-era K̄ (K-spread is applied pre-era in production). The case rows carry
  // POST-era K (× era_k), so bring K̄ into the same space (era_k factors out of the linear rescale,
  // so this is exact). Matters for EG (era-1920 era_k≈0.35); no-op for Bronze (era-2010 era_k≈1).
  const kbarPre = poolMeanK(basePool, coeffs, rp, fs, 50);
  const kbar = { hit: kbarPre.hit * coeffs.era_k, pit: kbarPre.pit * coeffs.era_k };
  // FRAME-V2 gap: reference is the TRAINING mean (TM), NOT the catalog top-50 field (refF).
  const gap = (role: "hit" | "pit", k: string) => (TM as any)[role][k] - (poolF as any)[role].vR[k].mu;
  const OG = { hit: { eye: gap("pit", "con"), kRat: gap("pit", "stu"), pow: gap("pit", "hrr"), babip: gap("pit", "pbabip"), gap: gap("pit", "pbabip") },
               pit: { con: gap("hit", "eye"), stu: gap("hit", "kRat"), hrr: gap("hit", "pow"), pbabip: gap("hit", "babip") } };
  // Sanity: the mis-basing the re-base removes (catalog refF − TM), per the §10.8 measurement.
  const misBase = (role: "hit" | "pit", k: string) => (refF as any)[role].vR[k].mu - (TM as any)[role][k];
  console.log(`[${name}] refF−TM mis-basing: hit.eye ${misBase("hit", "eye").toFixed(1)}  hit.pow ${misBase("hit", "pow").toFixed(1)}  pit.stu ${misBase("pit", "stu").toFixed(1)}  pit.hrr ${misBase("pit", "hrr").toFixed(1)}`);

  interface Agg { r: any; hPA: number; hK: number; pBF: number; pK: number; pBB: number; pIBB: number }
  const m = new Map<string, Agg>();
  let bfR = 0, bfAll = 0, paR = 0, paL = 0, paS = 0;
  for (const f of readdirSync(TDIR).filter((x) => x.endsWith(".csv"))) {
    const rawRows = Papa.parse(readFileSync(`${TDIR}/${f}`, "utf8"), { header: true, skipEmptyLines: true }).data as any[];
    const { cleaned, removed, report } = cleanTournamentRows(rawRows);
    console.log(`  [${name}] ${f}: ${report.status} (ledger ${report.ledger}→${report.residual}, removed ${removed.length}/${rawRows.length})`);
    for (const r of cleaned as any[]) {
      const pa = num(r.PA), bf = num(r.BF);
      if (bf > 0) { bfAll += bf; if (String(r.T) === "R") bfR += bf; }
      if (pa > 0) { const b = String(r.B); if (b === "R") paR += pa; else if (b === "L") paL += pa; else paS += pa; }
      const key = `${r.CID}|${r.VLvl}`; let a = m.get(key);
      if (!a) { a = { r, hPA: 0, hK: 0, pBF: 0, pK: 0, pBB: 0, pIBB: 0 }; m.set(key, a); }
      a.hPA += pa; a.hK += num(r.K); a.pBF += bf; a.pK += num(r.K_1); a.pBB += num(r.BB_1); a.pIBB += num(r.IBB_1);
    }
  }
  const wRhit = bfR / bfAll, wRpit: Record<number, number> = { 1: paR / (paR + paL + paS), 2: (paR + paS) / (paR + paL + paS) };
  const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  // hitter K, opp-gap-shifted
  const hitRows = [...m.values()].filter((a) => a.hPA >= TH).map((a) => {
    const side = (s: "vR" | "vL") => rp.predictHitting({ eye: R(a.r, s, "EYE") + OG.hit.eye, pow: R(a.r, s, "POW") + OG.hit.pow, kRat: R(a.r, s, "K") + OG.hit.kRat, babip: R(a.r, s, "BA") + OG.hit.babip, gap: R(a.r, s, "GAP") + OG.hit.gap, speed: 0, steal: 0, run: 0 }, coeffs).SO * coeffs.era_k;
    return { w: a.hPA, act: a.hK * 600 / a.hPA, pred: bl(side("vR"), side("vL"), wRhit), rat: bl(R(a.r, "vR", "K"), R(a.r, "vL", "K"), wRhit) };
  });
  // pitcher K + uBB, opp-gap-shifted (λ=1 baseline for BB)
  const pitRows = [...m.values()].filter((a) => a.pBF >= TH).map((a) => {
    const w = wRpit[thr(String(a.r.T))]!;
    const pr = (s: "vR" | "vL", lam = 1) => rp.predictPitching({ con: R(a.r, s, "CON") + lam * OG.pit.con, stu: R(a.r, s, "STU") + OG.pit.stu, pbabip: R(a.r, s, "PBABIP") + OG.pit.pbabip, hrr: R(a.r, s, "HRA") + OG.pit.hrr }, coeffs);
    return {
      w: a.pBF, actK: a.pK * 600 / a.pBF, predK: bl(pr("vR").K, pr("vL").K, w) * coeffs.era_k, rat: bl(R(a.r, "vR", "STU"), R(a.r, "vL", "STU"), w),
      actBB: (a.pBB - a.pIBB) * 600 / a.pBF, con: bl(R(a.r, "vR", "CON"), R(a.r, "vL", "CON"), w),
      bbAt: (lam: number) => bl(pr("vR", lam).BB, pr("vL", lam).BB, w) * coeffs.era_bb,
    };
  });
  cases.push({ name: `${name}·hit`, role: "hit", gapOwn: OG.hit.kRat, rows: hitRows, kbar: kbar.hit });
  cases.push({ name: `${name}·pit`, role: "pit", gapOwn: OG.pit.stu, rows: pitRows.map((r) => ({ w: r.w, act: r.actK, pred: r.predK, rat: r.rat })), kbar: kbar.pit });
  (cases[cases.length - 1] as any).pitBB = pitRows; // stash for the λ fit
  (cases[cases.length - 1] as any).eyeGap = OG.pit.con;
}

// ── s* per case: WLS fit of the PRODUCTION correction K_corr = K̄ + s·(K_pred − K̄) to actuals.
// Both pred and act are centered on K̄ = poolMeanK (production's centering point), so s minimizes
// Σw(act − K̄ − s(pred − K̄))² → s = Σw(pred−K̄)(act−K̄)/Σw(pred−K̄)². (The old fit centered on the
// PA-weighted participant mean, a DIFFERENT point than production — audit item 6.) ──
const sStar = (c: TCase) => {
  const kb = c.kbar;
  const w = c.rows.map((r) => r.w);
  const mp = wmean(c.rows.map((r) => r.pred), w), ma = wmean(c.rows.map((r) => r.act), w);
  let num_ = 0, den = 0;
  for (const r of c.rows) { num_ += r.w * (r.pred - kb) * (r.act - kb); den += r.w * (r.pred - kb) ** 2; }
  return { s: num_ / den, mp, ma, kbar: kb, levelBias: mp - ma };
};
// quintile slope ratio (Q5−Q1 spread), for continuity with earlier reports
const slopeRatio = (c: TCase, s = 1) => {
  const rows = [...c.rows].sort((a, b) => a.rat - b.rat);
  const q = Math.ceil(rows.length / 5);
  const g = (grp: typeof rows, f: (r: (typeof rows)[0]) => number) => wmean(grp.map(f), grp.map((r) => r.w));
  const q1 = rows.slice(0, q), q5 = rows.slice(4 * q);
  if (!q1.length || !q5.length) return NaN;
  const corr = (r: (typeof rows)[0]) => c.kbar + s * (r.pred - c.kbar); // center on production K̄_pool
  return (g(q5, corr) - g(q1, corr)) / (g(q5, (r) => r.act) - g(q1, (r) => r.act));
};

console.log(`\n=== s* (spread scale needed) per tournament × role — post opp-gap, per-card WLS ===`);
console.log(`case      gapOwn   s*     slopeRatio@s=1   @s=s*   levelBias`);
for (const c of cases) {
  const { s, levelBias } = sStar(c);
  console.log(`${c.name.padEnd(9)} ${c.gapOwn.toFixed(1).padStart(6)} ${s.toFixed(2).padStart(6)} ${slopeRatio(c, 1).toFixed(2).padStart(12)} ${slopeRatio(c, s).toFixed(2).padStart(9)} ${levelBias.toFixed(1).padStart(10)}`);
}

// ── cross-validation of parameterizations ──
console.log(`\n=== Cross-tournament validation (fit on one, apply to the other) ===`);
console.log(`P0 constant-s:  fit s on tournament A (pooled roles), apply to B`);
console.log(`P1 linear-gap:  s = 1 + β·gapOwn, β fit on A, apply to B`);
const byT = { EG: cases.filter((c) => c.name.startsWith("EG")), BR: cases.filter((c) => c.name.startsWith("BR")) };
for (const [fitT, valT] of [["EG", "BR"], ["BR", "EG"]] as const) {
  const fitCases = byT[fitT], valCases = byT[valT];
  // P0: PA-weighted pooled s across the two roles
  const sVals = fitCases.map((c) => sStar(c).s), sWts = fitCases.map((c) => c.rows.reduce((s2, r) => s2 + r.w, 0));
  const s0 = wmean(sVals, sWts);
  // P1: β = weighted mean of (s−1)/gap
  const betas = fitCases.map((c) => (sStar(c).s - 1) / c.gapOwn);
  const b1 = wmean(betas, sWts);
  console.log(`\nfit ${fitT} → validate ${valT}:   s0=${s0.toFixed(2)}  β=${b1.toFixed(4)}`);
  console.log(`  case      slope@s=1   P0(s=${s0.toFixed(2)})   P1(s=1+β·gap)`);
  for (const c of valCases) {
    const sP1 = 1 + b1 * c.gapOwn;
    console.log(`  ${c.name.padEnd(9)} ${slopeRatio(c, 1).toFixed(2).padStart(8)} ${slopeRatio(c, s0).toFixed(2).padStart(12)} ${slopeRatio(c, sP1).toFixed(2).padStart(12)}  (s=${sP1.toFixed(2)})`);
  }
}

// ── pitcher BB level: λ fit (shift multiplier on the eye-gap) ──
console.log(`\n=== Pitcher uBB level residual — λ (opp-gap shift multiplier on CON) ===`);
for (const c of cases.filter((x) => x.role === "pit")) {
  const rows = (c as any).pitBB as any[];
  const w = rows.map((r) => r.w);
  const target = wmean(rows.map((r) => r.actBB), w);
  const at = (l: number) => wmean(rows.map((r) => r.bbAt(l)), w);
  // solve λ by bisection: predicted mean uBB(λ) = actual mean. bbAt is DECREASING in λ (more CON
  // shift ⇒ better control ⇒ fewer BB), so the root exists only if at(hi) ≤ target ≤ at(lo).
  // GUARD (audit item 5): if the target is OUTSIDE [at(hi), at(lo)], bisection would converge to a
  // bracket boundary and report it as a "fit" — reject that, report the boundary as a bound, not a root.
  const LO = 0.5, HI = 4;
  const fLo = at(LO), fHi = at(HI);
  let lam: number, note: string;
  if (target > fLo) { lam = LO; note = `λ*<${LO} (unbracketed — even λ=${LO} over-predicts by ${(fLo - target).toFixed(1)})`; }
  else if (target < fHi) { lam = HI; note = `λ*>${HI} (unbracketed — even λ=${HI} over-predicts by ${(fHi - target).toFixed(1)})`; }
  else {
    let lo = LO, hi = HI;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(mid) > target) lo = mid; else hi = mid; }
    lam = (lo + hi) / 2; note = `λ*=${lam.toFixed(2)} → ${at(lam).toFixed(1)}`;
  }
  console.log(`${c.name.padEnd(9)} eyeGap=${(c as any).eyeGap.toFixed(1)}  actual uBB=${target.toFixed(1)}  pred@λ=1: ${at(1).toFixed(1)} (bias ${(at(1) - target).toFixed(1)})  ${note}`);
}
console.log(`\n(λ* ≈ same value across both tournaments ⇒ a universal CON-shift multiplier; wildly different ⇒ not a clean gap-proportional story.)`);
process.exit(0);
