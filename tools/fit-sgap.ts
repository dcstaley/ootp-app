// PHASE-1 FIT: the gap-conditioned K-spread ramp s_role(gap) (plan §11.19, Fable Change 1).
//   K_corr = K̄_pool + s_role(gap)·(K_pred − K̄_pool),   s(g) = 1 + A_role·(1 − e^(−g/G))
// s(0)=1 is baked into the form (league protection automatic). Joint per-card fit over the quicks
// ladder (Open/Bronze-q/Gold-q), per role, PA/BF-weighted, ghost-cleaned. For a fixed G the model is
// LINEAR in A (K_corr = K_pred + A·[u·(K_pred−K̄)], u=1−e^(−g/G)) ⇒ closed-form A, grid-search G.
// EG/Bronze-tournament are OUT-OF-LADDER checks (not fit). Reports fitted A_hit/A_pit/G + s at each
// gap + weighted-SSE reduction vs no-correction and vs the interim hand-tuned ramp.
//   run: node tools/fit-sgap.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, type TournamentObs } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const FIELD_N = 50, TH = 100;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const rp = makeRawPolyModel(trained.eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const sh = (v: number, d: number | undefined) => (d ? Math.max(0, v + d) : v);
const thr = (x: number) => (x === 1 ? 1 : 2);

// One per-card K row for the fit: predicted K (frame-shifted, ×era_k, NO spread), actual, weight,
// the pool's K̄ (post-era), and the pool's own-channel K gap.
interface KRow { pred: number; act: number; w: number; kbar: number; gap: number }

async function collect(dir: string, TID: string): Promise<{ hit: KRow[]; pit: KRow[]; gapHit: number; gapPit: number }> {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const eraK = coeffs.era_k;
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, rp, fs, FIELD_N); // pre-era
  const kbarHit = kb.hit * eraK, kbarPit = kb.pit * eraK;
  const gapHit = fs.hit.vR.kRat ?? 0, gapPit = fs.pit.vR.stu ?? 0;
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
  const hit: KRow[] = obs.filter((o: TournamentObs) => o.pa >= TH).map((o) => {
    const K = (s: "vR" | "vL") => { const d = fs.hit[s], r = o.ratings.hit[s]; return rp.predictHitting({ eye: sh(r.eye, d.eye), pow: sh(r.pow, d.pow), kRat: sh(r.kRat, d.kRat), babip: sh(r.babip, d.babip), gap: sh(r.gap, d.gap), speed: 0, steal: 0, run: 0 }, coeffs).SO * eraK; };
    return { pred: bl(K("vR"), K("vL"), exposure.wRhit), act: o.actual.hit.K, w: o.pa, kbar: kbarHit, gap: gapHit };
  });
  const pit: KRow[] = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => {
    const w = exposure.wRpit[thr(o.throws)]!;
    const K = (s: "vR" | "vL") => { const d = fs.pit[s], r = o.ratings.pit[s]; return rp.predictPitching({ con: sh(r.con, d.con), stu: sh(r.stu, d.stu), pbabip: sh(r.pbabip, d.pbabip), hrr: sh(r.hrr, d.hrr) }, coeffs).K * eraK; };
    return { pred: bl(K("vR"), K("vL"), w), act: o.actual.pit.K, w: o.bf, kbar: kbarPit, gap: gapPit };
  });
  return { hit, pit, gapHit, gapPit };
}

const LADDER = [["Open", "Tournament Data/Quicks - Open", "default-neutral"], ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"], ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"]] as const;
const CHECKS = [["EG", "Tournament Data/Early Gold", "early-gold"], ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"]] as const;

const ladder = [] as { name: string; d: Awaited<ReturnType<typeof collect>> }[];
for (const [name, dir, tid] of LADDER) ladder.push({ name, d: await collect(dir, tid) });
const checks = [] as { name: string; d: Awaited<ReturnType<typeof collect>> }[];
for (const [name, dir, tid] of CHECKS) checks.push({ name, d: await collect(dir, tid) });

const wsse = (rows: KRow[], s: (g: number) => number) => rows.reduce((acc, r) => { const corr = r.kbar + s(r.gap) * (r.pred - r.kbar); return acc + r.w * (corr - r.act) ** 2; }, 0);
const wsum = (rows: KRow[]) => rows.reduce((a, r) => a + r.w, 0);

// Fit A (closed form) for a given G on the pooled ladder rows of one role, then grid-search G.
function fitRole(rows: KRow[]) {
  let best = { G: NaN, A: NaN, sse: Infinity };
  for (let G = 3; G <= 60; G += 0.5) {
    let num = 0, den = 0;
    for (const r of rows) { const u = 1 - Math.exp(-r.gap / G); const z = u * (r.pred - r.kbar); const resid = r.pred - r.act; num += r.w * z * resid; den += r.w * z * z; }
    const A = den > 0 ? -num / den : 0;
    const s = (g: number) => 1 + A * (1 - Math.exp(-g / G));
    const sse = wsse(rows, s);
    if (sse < best.sse) best = { G, A, sse };
  }
  return best;
}

console.log(`Phase-1 s(gap) fit — active model ${trained.id}, ladder ${LADDER.map((l) => l[0]).join("/")}, TH ${TH} PA/BF\n`);
for (const role of ["hit", "pit"] as const) {
  const rows = ladder.flatMap((l) => l.d[role]);
  const f = fitRole(rows);
  const s = (g: number) => 1 + f.A * (1 - Math.exp(-g / f.G));
  const sHand = (g: number) => 1 + 0.75 * Math.min(Math.max(g / 17, 0), 1); // interim S_K=1.75,G0=17
  const base = wsse(rows, () => 1), fit = wsse(rows, s), hand = wsse(rows, sHand), tot = wsum(rows);
  console.log(`==== ${role.toUpperCase()}  A=${f.A.toFixed(2)}  G=${f.G.toFixed(1)}  →  s(g)=1+${f.A.toFixed(2)}·(1−e^(−g/${f.G.toFixed(0)})),  plateau≈${(1 + f.A).toFixed(2)}`);
  console.log(`   wRMSE/600:  no-corr ${Math.sqrt(base / tot).toFixed(2)}   FITTED ${Math.sqrt(fit / tot).toFixed(2)}   interim-hand ${Math.sqrt(hand / tot).toFixed(2)}`);
  const line = (arr: typeof ladder) => arr.map((l) => `${l.name} g=${(l.d[role === "hit" ? "gapHit" : "gapPit"]).toFixed(0)} s=${s(l.d[role === "hit" ? "gapHit" : "gapPit"]).toFixed(2)}`).join("  |  ");
  console.log(`   ladder:  ${line(ladder)}`);
  console.log(`   checks:  ${line(checks)}   (out-of-ladder — s applied at their measured gap)`);
}
process.exit(0);
