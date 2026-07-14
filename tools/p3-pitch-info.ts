// P3 — PITCH-INFO FALSIFICATION. The shipped pitcher form is quad on {HR,K,H}; the leading interpretation is
// that those quad terms PROXY omitted pitch-level info (repertoire size, velocity, GB/FB tendency) correlated
// with the 4 aggregate ratings (con/stu/hrr/pbabip). TEST: regress the shipped-form pitcher VALUE residual
// (actual − affine-aligned pred) on PIT (repertoire), VELO (mid of the range), G/F (GB−FB tendency). If any
// carries signal ⇒ the aggregates miss pitch-level info ⇒ a repertoire AUX is a principled ceiling-raiser AND
// the Bronze-t suspect. If FLAT ⇒ the proxy narrative dies (the quad is just curvature, no omitted variable).
// Pooled across the reliable ladder (EG/Bronze-t/quicks), affine-aligned per-dataset so residuals are centered.
//   run: node tools/p3-pitch-info.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs } from "../src/training/tournament-eval.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const hitFit = fitHitForm(RAWPOLY_HIT, lgObs);
// TWO forms: quad = shipped pareto; log = deployed StuffAug (K/HR/H all log + aux). If the LOG residual
// correlates with pitch-info but the QUAD residual does NOT, the quad ABSORBED pitch-info (proxy hypothesis
// TRUE). If BOTH are flat, pitch-info is irrelevant and the quad is pure curvature (proxy hypothesis FALSE).
const FORMS: [string, any][] = [
  ["quad(shipped)", { hit: hitFit, pit: fitPitForm(PARETO, lgObs) }],
  ["log(StuffAug)", { hit: hitFit, pit: fitPitForm(STUFFAUG_PIT as PitForm, lgObs) }],
];

// Parse pitch-info per CID from the raw CSVs (card-constant across runnings; take the first seen).
const gfMap: Record<string, number> = { "EX GB": -2, GB: -1, NEU: 0, FB: 1, "EX FB": 2 };
const velMid = (s: string) => { const m = String(s).match(/(\d+)\s*-\s*(\d+)/); if (m) return (+m[1]! + +m[2]!) / 2; const n = Number(s); return Number.isFinite(n) ? n : NaN; };
function pitchInfo(dir: string): Map<string, { pit: number; velo: number; gf: number }> {
  const out = new Map<string, { pit: number; velo: number; gf: number }>();
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".csv"))) {
    for (const r of (Papa.parse<any>(readFileSync(join(dir, f), "utf8"), { header: true, skipEmptyLines: true }).data ?? [])) {
      const cid = String(r["CID"] ?? ""); if (!cid || out.has(cid)) continue;
      const pit = Number(r["PIT"]), velo = velMid(r["VELO"]), gf = gfMap[String(r["G/F"] ?? "").trim().toUpperCase()] ?? (String(r["G/F"] ?? "").trim() ? NaN : 0);
      if (Number.isFinite(pit) && Number.isFinite(velo)) out.set(cid, { pit, velo, gf: Number.isFinite(gf) ? gf : 0 });
    }
  }
  return out;
}

const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
// weighted partial correlation of residual with each feature (standardized), via multiple WLS.
function wls(X: number[][], y: number[], w: number[]): number[] { const p = X[0]!.length; const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0)), b: number[] = new Array(p).fill(0); for (let r = 0; r < X.length; r++) { for (let i = 0; i < p; i++) { b[i]! += w[r]! * X[r]![i]! * y[r]!; for (let j = 0; j < p; j++) A[i]![j]! += w[r]! * X[r]![i]! * X[r]![j]!; } } // solve
  for (let i = 0; i < p; i++) { let piv = A[i]![i]!; if (Math.abs(piv) < 1e-12) piv = 1e-12; for (let j = 0; j < p; j++) A[i]![j]! /= piv; b[i]! /= piv; for (let k = 0; k < p; k++) if (k !== i) { const fct = A[k]![i]!; for (let j = 0; j < p; j++) A[k]![j]! -= fct * A[i]![j]!; b[k]! -= fct * b[i]!; } } return b; }

const std = (v: number[], w: number[]) => { const m = wmean(v, w); const sd = Math.sqrt(wmean(v.map((x) => (x - m) ** 2), w)) || 1; return v.map((x) => (x - m) / sd); };
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(4) : "  n/a");

console.log(`P3 — PITCH-INFO FALSIFICATION. Pitcher VALUE residual (actual − affine-aligned pred) vs pitch-level features,`);
console.log(`for the QUAD (shipped) vs LOG (StuffAug) form. Pooled reliable ladder ≥${TH} BF, per-dataset centered.`);
console.log(`DISCRIMINATOR: log residual correlates with pitch-info but quad does NOT ⇒ quad ABSORBED it (proxy TRUE).`);
console.log(`Both flat ⇒ pitch-info irrelevant, quad is pure curvature (proxy FALSE).\n`);

for (const [fname, ef2] of FORMS) {
  const rp2 = makeRawPolyModel(ef2);
  const rows: { resid: number; pit: number; velo: number; gf: number; w: number }[] = [];
  for (const [name, dir, TID] of [
    ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
    ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
    ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
    ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
  ] as const) {
    if (!existsSync(dir)) continue;
    const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
    const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
    if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
    const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
    const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
    const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp2, FIELD_N, true);
    const poolField = computeUnifiedFieldStats(basePool, coeffs, rp2, FIELD_N, true);
    const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
    const obs = loadTournamentOutcomes(dir, { clean: (rows2) => cleanTournamentRows(rows2).cleaned });
    const exposure = tournamentExposure(obs);
    const cv = tournamentCardValues(obs, { coeffs, eventForm: ef2, ...own }, exposure, { minPA: TH, minBF: TH }).pit;
    const qual = obs.filter((o: TournamentObs) => o.bf >= TH);
    const info = pitchInfo(dir);
    const mp = wmean(cv.pred, cv.w), mr = wmean(cv.real, cv.w); let cov = 0, vp = 0;
    for (let i = 0; i < cv.pred.length; i++) { const dp = cv.pred[i]! - mp; cov += cv.w[i]! * dp * (cv.real[i]! - mr); vp += cv.w[i]! * dp * dp; }
    const beta = vp > 1e-15 ? cov / vp : 0, alpha = mr - beta * mp;
    qual.forEach((o, i) => { const inf = info.get(o.cid); if (!inf) return; rows.push({ resid: cv.real[i]! - (alpha + beta * cv.pred[i]!), pit: inf.pit, velo: inf.velo, gf: inf.gf, w: cv.w[i]! }); });
  }
  const W = rows.map((r) => r.w), y = rows.map((r) => r.resid);
  const zPit = std(rows.map((r) => r.pit), W), zVelo = std(rows.map((r) => r.velo), W), zGf = std(rows.map((r) => r.gf), W);
  const b = wls(rows.map((_, i) => [1, zPit[i]!, zVelo[i]!, zGf[i]!]), y, W);
  const residSD = Math.sqrt(wmean(y.map((v) => v * v), W));
  const corr = (z: number[]) => { const my = wmean(y, W); let c = 0, vz = 0, vy = 0; for (let i = 0; i < y.length; i++) { c += W[i]! * z[i]! * (y[i]! - my); vz += W[i]! * z[i]! * z[i]!; vy += W[i]! * (y[i]! - my) ** 2; } return c / Math.sqrt(vz * vy); };
  // multiple-R²: how much residual variance the 3 pitch features JOINTLY explain
  const yhat = rows.map((_, i) => b[0]! + b[1]! * zPit[i]! + b[2]! * zVelo[i]! + b[3]! * zGf[i]!);
  const ssTot = wmean(y.map((v) => (v - wmean(y, W)) ** 2), W), ssRes = wmean(y.map((v, i) => (v - yhat[i]!) ** 2), W);
  const r2 = 1 - ssRes / ssTot;
  console.log(`── ${fname}  (N=${rows.length}, residSD=${residSD.toFixed(4)}) ──`);
  console.log(`   corr(resid): PIT ${f(corr(zPit))}  VELO ${f(corr(zVelo))}  G/F ${f(corr(zGf))}   |  joint R²=${f(r2)}  (frac of residual var pitch-info explains)`);
}
console.log(`\nRead: both forms' R² ≈ 0 ⇒ pitch-info explains ~none of the residual under EITHER ⇒ proxy narrative FALSE (quad = curvature).`);
console.log(`log R² ≫ quad R² ⇒ the quad absorbed a real pitch-info signal ⇒ a repertoire aux is the principled ceiling-raiser (escalate).`);
process.exit(0);
