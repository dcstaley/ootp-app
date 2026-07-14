// VERIFICATION DEBT B.3 — per-channel LEVEL calibration under quad at the rating-range EDGES.
// A raw-quad can fit the bulk yet bias the level in the lowest/highest rating bins — exactly where
// weak-pool (low) and elite (high) cards sit. For each pitcher event, bin league pitchers by the
// DRIVING rating into edge terciles (low / mid / high) and report predicted−actual per-600 level bias
// per bin, for deployed vs {HR,K,H} pareto vs {all} winner. Quad is acceptable only if edge bias is
// no worse than log's. (In-frame fit re-centers the global mean → bias lives in the shape, at the edges.)
//   run: node tools/phase1c-b3-edgelevels.ts
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { fitPitForm, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import type { EventForm, FittedHit } from "../src/model/curves.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const MINN = 1000;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const lgPit = lgObs.filter((o) => PITCHER.qualifies(o, MINN));
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const HIT = trained.eventForm.hit as FittedHit;
const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);

const DEPLOYED: PitForm = STUFFAUG_PIT as PitForm;
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const WINNER: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{all}", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true };

// event → driving rating + actual per-600 extractor
const EVENTS = [
  { ev: "K", rat: (o: TrainObs) => o.ratings.pitch.stu, act: (o: TrainObs) => per600(o.pitch.K, o.pitch.BF), pred: (k: any) => k.K_pred },
  { ev: "uBB", rat: (o: TrainObs) => o.ratings.pitch.con, act: (o: TrainObs) => per600(o.pitch.BB - o.pitch.IBB, o.pitch.BF), pred: (k: any) => k.BB_fin },
  { ev: "HR", rat: (o: TrainObs) => o.ratings.pitch.hrr, act: (o: TrainObs) => per600(o.pitch.HR, o.pitch.BF), pred: (k: any) => k.HR_fin },
] as const;

function predEvents(pf: PitForm) {
  const ef: EventForm = { hit: HIT, pit: fitPitForm(pf, lgObs) };
  const m = makeRawPolyModel(ef);
  return lgPit.map((o) => {
    const e = m.predictPitching(o.ratings.pitch, coeffs);
    const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, ef);
    return { BB_fin: k.BB_fin, HR_fin: k.HR_fin, K_pred: e.K * coeffs.era_k };
  });
}

const forms: [string, PitForm][] = [["deployed", DEPLOYED], ["{HR,K,H}", PARETO], ["{all}", WINNER]];
const preds = new Map(forms.map(([n, pf]) => [n, predEvents(pf)]));
const wmean = (idx: number[], get: (i: number) => number, wt: (i: number) => number) => { let a = 0, b = 0; for (const i of idx) { a += wt(i) * get(i); b += wt(i); } return b ? a / b : 0; };

console.log(`B.3 EDGE-LEVEL calibration — per-channel pred−actual per-600 bias by rating tercile (LOW=weak-pool edge,`);
console.log(`HIGH=elite edge). N=${lgPit.length}. Quad OK iff edge bias ≤ log's. bf-weighted.\n`);
for (const { ev, rat, act, pred } of EVENTS) {
  const sorted = lgPit.map((o, i) => ({ i, r: rat(o) })).sort((a, b) => a.r - b.r);
  const t = Math.floor(sorted.length / 3);
  const bins = [["LOW", sorted.slice(0, t)], ["MID", sorted.slice(t, 2 * t)], ["HIGH", sorted.slice(2 * t)]] as const;
  console.log(`${ev} (←${ev === "K" ? "stu" : ev === "uBB" ? "con" : "hrr"}):`);
  for (const [bn, arr] of bins) {
    const idx = arr.map((x) => x.i), rlo = arr[0]!.r, rhi = arr[arr.length - 1]!.r;
    const wt = (i: number) => lgPit[i]!.pitch.BF;
    const actMean = wmean(idx, (i) => act(lgPit[i]!), wt);
    const row = forms.map(([n]) => { const p = preds.get(n)!; return (wmean(idx, (i) => pred(p[i]), wt) - actMean); });
    console.log(`  ${bn.padEnd(5)} rating[${rlo.toFixed(0)}-${rhi.toFixed(0)}] actual=${actMean.toFixed(1).padStart(5)}  bias: deployed ${row[0]!.toFixed(2).padStart(6)}  {HR,K,H} ${row[1]!.toFixed(2).padStart(6)}  {all} ${row[2]!.toFixed(2).padStart(6)}`);
  }
}
console.log(`\nRead: is any form's LOW or HIGH bias materially worse than deployed(log)? A quad that fits the bulk but`);
console.log(`biases an edge would show a large |bias| in that tercile — the reason the original bake-off gated quad.`);
process.exit(0);
