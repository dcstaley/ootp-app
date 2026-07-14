// PHASE-1c LOOSE END (item 25) — HITTER CANCELLATION DECOMPOSITION. The pooled hitter value spread is
// ~0.96-0.97 (healthy), but a pooled ratio can HIDE offsetting per-channel errors: e.g. kRat under-spread
// canceled by babip/eye over-spread. If so, the 0.96 is luck that un-cancels under pool-composition shifts
// (weird tournament pools). Decompose: per event channel, the deconvolved spread ratio SD(pred)/SD(true)
// AND the wOBA-weighted contribution to value variance. All ≈1 ⇒ genuine per-channel correctness. A mix of
// >1 and <1 ⇒ cancellation risk (flag pool-composition sensitivity). In-frame league, deployed RAWPOLY_HIT.
//   run: node tools/phase1c-hit-cancellation.ts
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived } from "../src/scoring-core/index.ts";
import { hittingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import type { EventForm, FittedHit } from "../src/model/curves.ts";

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
const lgHit = lgObs.filter((o) => HITTER.qualifies(o, MINN));
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const w = wobaWeightsFromCoeffs(coeffs);
const ef: EventForm = { hit: trained.eventForm.hit as FittedHit, pit: trained.eventForm.pit };
const m = makeRawPolyModel(ef);
const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);

const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const mn = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - mn) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };

// Per-event predicted & actual per-600 rates + the Poisson SE of the actual rate (for deconvolution).
interface Ch { pred: number[]; real: number[]; se: number[]; weight: number }
const chans: Record<string, Ch> = { uBB: { pred: [], real: [], se: [], weight: w.bb }, K: { pred: [], real: [], se: [], weight: 0 }, HR: { pred: [], real: [], se: [], weight: w.hr }, oneB: { pred: [], real: [], se: [], weight: w.b1 }, XBH: { pred: [], real: [], se: [], weight: w.xbh } };
const wt: number[] = [];
const valPred: number[] = [], valReal: number[] = [];
for (const o of lgHit) {
  const e = m.predictHitting(o.ratings.hit, coeffs);
  const k = hittingComponents(e, 1, 1, 1, "vR", coeffs, derived, ef);
  const uBBp = k.BB_fin, Kp = e.SO * coeffs.era_k, HRp = k.HR_fin, oneBp = k.oneB_fin, XBHp = k.GAP_fin;
  const uBBa = per600(o.hit.BB - o.hit.IBB, o.hit.PA), Ka = per600(o.hit.K, o.hit.PA), HRa = per600(o.hit.HR, o.hit.PA);
  const Ha = per600(o.hit.H - o.hit.HR, o.hit.PA), XBHa = per600(o.hit.b2 + o.hit.b3, o.hit.PA), oneBa = Ha - XBHa;
  const d = o.hit.PA;
  const seP = (rate: number) => (d > 0 ? Math.sqrt(Math.max(rate, 0) / 600 * (1 - Math.max(rate, 0) / 600) / d) * 600 : 0);
  chans.uBB!.pred.push(uBBp); chans.uBB!.real.push(uBBa); chans.uBB!.se.push(seP(uBBa));
  chans.K!.pred.push(Kp); chans.K!.real.push(Ka); chans.K!.se.push(seP(Ka));
  chans.HR!.pred.push(HRp); chans.HR!.real.push(HRa); chans.HR!.se.push(seP(HRa));
  chans.oneB!.pred.push(oneBp); chans.oneB!.real.push(oneBa); chans.oneB!.se.push(seP(oneBa));
  chans.XBH!.pred.push(XBHp); chans.XBH!.real.push(XBHa); chans.XBH!.se.push(seP(XBHa));
  wt.push(o.hit.PA);
  valPred.push((w.bb * uBBp + w.hbp * coeffs.adv_hbp + w.b1 * oneBp + w.xbh * XBHp + w.hr * HRp) / 600);
  valReal.push((w.bb * uBBa + w.hbp * coeffs.adv_hbp + w.b1 * oneBa + w.xbh * XBHa + w.hr * HRa) / 600);
}

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");
console.log(`HITTER CANCELLATION DECOMPOSITION — in-frame league, N=${lgHit.length}. Per-channel deconvolved spread ratio`);
console.log(`+ wOBA-weighted contribution to VALUE variance. All≈1 ⇒ genuine; mix of >1 and <1 ⇒ cancellation risk.\n`);
console.log(`channel  wOBAwt  SD(pred)  SD(true)  ratio   varContrib(pred, wt·SD²)`);
for (const [name, c] of Object.entries(chans)) {
  const sPred = Math.sqrt(wvar(c.pred, wt));
  const sTrue = Math.sqrt(Math.max(wvar(c.real, wt) - wmean(c.se.map((s) => s * s), wt), 1e-9));
  const contrib = (c.weight / 600) ** 2 * wvar(c.pred, wt); // this channel's share of predicted value variance
  console.log(`${name.padEnd(8)} ${f(c.weight)}  ${sPred.toFixed(2).padStart(6)}  ${sTrue.toFixed(2).padStart(6)}  ${f(sTrue > 0 ? sPred / sTrue : NaN)}  ${(contrib * 1e6).toFixed(3)} (×1e-6)`);
}
const sVP = Math.sqrt(wvar(valPred, wt));
// assembled-value true SD via deconvolution using the value-level SE (weight-combined)
const valSE = lgHit.map((o, i) => { const t: [number, number][] = [[w.bb, chans.uBB!.real[i]! / 600], [w.b1, chans.oneB!.real[i]! / 600], [w.xbh, chans.XBH!.real[i]! / 600], [w.hr, chans.HR!.real[i]! / 600]]; const E = t.reduce((s, [ww, p]) => s + ww * p, 0), E2 = t.reduce((s, [ww, p]) => s + ww * ww * p, 0); return o.hit.PA > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / o.hit.PA) : 0; });
const sVT = Math.sqrt(Math.max(wvar(valReal, wt) - wmean(valSE.map((s) => s * s), wt), 1e-9));
console.log(`\nASSEMBLED VALUE: SD(pred)=${sVP.toFixed(4)}  SD(true)=${sVT.toFixed(4)}  ratio=${f(sVP / sVT)} (the pooled 0.96-0.97)`);
console.log(`\nRead: if the per-channel ratios are all ≈1 (esp. the high-varContrib channels HR/1B/XBH), the pooled ratio`);
console.log(`is genuine — not offsetting errors. K's ratio is value-IRRELEVANT (wOBA weight 0; K enters only via BIP→1B).`);
console.log(`A channel with a large varContrib AND a ratio far from 1 is the cancellation lever to flag.`);
process.exit(0);
