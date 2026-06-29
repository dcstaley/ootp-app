// DIAGNOSTIC — is pooling all leagues into "full years" the right training unit, or
// does mixing different-strength leagues (PEL ~0.2-0.3σ stronger than HD) blur the
// fit? Test: predict held-out PEL cards two ways —
//   train PEL-only  (other PEL folds)              ← clean single pool
//   train ALL leagues (other folds, test cards excluded) ← the current pooled design
// Same PEL test set + PEL-only outcomes for both. If "train ALL → predict PEL" is
// notably WORSE than "train PEL → predict PEL", pooling the HD leagues is hurting and
// the fix is per-league or training-side pool-adjustment. If they're ~equal, pooling
// is fine (leagues similar enough) and the pool effect is small.
//
// Run: node tools/per-league-fit.ts

import { existsSync } from "node:fs";
import { loadWindow, loadWindowLeagues, type TrainObs } from "../src/training/loader.ts";
import { foldOf } from "../src/training/evaluate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { HITTER, PITCHER, type RoleSpec } from "../src/training/bakeoff.ts";
import { RAWPOLY_HIT, RAWPOLY_PIT, LOG_HIT, LOG_PIT, fitHitForm, predictHitForm, fitPitForm, predictPitForm, type HitForm, type PitForm } from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const WINDOW = [2037, 2038, 2039, 2040];
const MIN_N = 600, K = 5, TOPN = 26;
// deterministic hash for a representative ALL→PEL-size subsample (no RNG).
const fnv = (key: string) => { let h = 2166136261; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const PEL = loadWindowLeagues(DIR, WINDOW, ["PEL"]).observations;
const ALL = loadWindow(DIR, WINDOW).observations;

function compare(label: string, role: RoleSpec, isHit: boolean, hitForm: HitForm, pitForm: PitForm) {
  const fit = (obs: TrainObs[]) => (isHit ? fitHitForm(hitForm, obs) : fitPitForm(pitForm, obs));
  const pred = (p: any, o: TrainObs) => (isHit ? predictHitForm(p, o) : predictPitForm(p, o));
  const pelQ = PEL.filter((o) => role.qualifies(o, MIN_N));
  const allQ = ALL.filter((o) => role.qualifies(o, MIN_N));
  // weighted SD of ACTUAL wOBA over each qualified pool — the Pearson denominator.
  const wsd = (obs: TrainObs[]) => {
    const w = obs.map((o) => role.weight(o)), v = obs.map((o) => role.actualWoba(o)), W = w.reduce((s, x) => s + x, 0);
    const m = v.reduce((s, x, i) => s + w[i]! * x, 0) / W;
    return Math.sqrt(v.reduce((s, x, i) => s + w[i]! * (x - m) ** 2, 0) / W);
  };

  const fromPEL: number[] = [], fromALL: number[] = [], fromALLm: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < K; f++) {
    const testPEL = pelQ.filter((o) => foldOf(o.key, K) === f);
    if (!testPEL.length) continue;
    const testKeys = new Set(testPEL.map((o) => o.key));
    const trainPEL = pelQ.filter((o) => !testKeys.has(o.key));
    const trainALL = allQ.filter((o) => !testKeys.has(o.key)); // test cards fully excluded
    if (trainPEL.length < 10 || trainALL.length < 10) continue;
    // matched-N: representative ALL subsample down to PEL's training size (isolates diversity from volume)
    const trainALLm = [...trainALL].sort((a, b) => fnv(a.key) - fnv(b.key)).slice(0, trainPEL.length);
    const mPEL = fit(trainPEL), mALL = fit(trainALL), mALLm = fit(trainALLm);
    testPEL.forEach((o) => { fromPEL.push(pred(mPEL, o)); fromALL.push(pred(mALL, o)); fromALLm.push(pred(mALLm, o)); actual.push(role.actualWoba(o)); weight.push(role.weight(o)); });
  }
  const pPEL = evalMetrics(fromPEL, actual, weight, role.higherBetter, TOPN).pearson;
  const pALL = evalMetrics(fromALL, actual, weight, role.higherBetter, TOPN).pearson;
  const pALLm = evalMetrics(fromALLm, actual, weight, role.higherBetter, TOPN).pearson;

  // reference: standard CV training+testing on ALL cards (the current design's headline)
  const aPred: number[] = [], aAct: number[] = [], aW: number[] = [];
  for (let f = 0; f < K; f++) {
    const te = allQ.filter((o) => foldOf(o.key, K) === f), tr = allQ.filter((o) => foldOf(o.key, K) !== f);
    if (!te.length || tr.length < 10) continue;
    const m = fit(tr);
    te.forEach((o) => { aPred.push(pred(m, o)); aAct.push(role.actualWoba(o)); aW.push(role.weight(o)); });
  }
  const pAllAll = evalMetrics(aPred, aAct, aW, role.higherBetter, TOPN).pearson;

  const d = pALL - pPEL;
  const meanExp = (obs: TrainObs[]) => Math.round(obs.reduce((s, o) => s + (isHit ? o.hit.PA : o.pitch.BF), 0) / Math.max(obs.length, 1));
  console.log(`\n== ${label} ==  (PEL N=${pelQ.length} @ ${meanExp(pelQ)} avg ${isHit ? "PA" : "BF"}, ALL N=${allQ.length} @ ${meanExp(allQ)}; actual-wOBA SD: PEL=${(wsd(pelQ) * 1000).toFixed(1)}pts, ALL=${(wsd(allQ) * 1000).toFixed(1)}pts)`);
  const dm = pALLm - pPEL;
  console.log(`  train PEL-only      → predict PEL:  ${pPEL.toFixed(4)}`);
  console.log(`  train ALL (full)    → predict PEL:  ${pALL.toFixed(4)}   (Δ vs PEL = ${d >= 0 ? "+" : ""}${d.toFixed(4)}  ← volume + diversity)`);
  console.log(`  train ALL (=PEL N)  → predict PEL:  ${pALLm.toFixed(4)}   (Δ vs PEL = ${dm >= 0 ? "+" : ""}${dm.toFixed(4)}  ← diversity at EQUAL N; <0 ⇒ same-pool data more valuable per-card ⇒ pool-relativity)`);
  console.log(`  [ref] train ALL → predict ALL:  ${pAllAll.toFixed(4)}`);
}

console.log(`per-league-fit — window ${WINDOW.join("+")}, minN=${MIN_N}, ${K}-fold by card key; weighted Pearson`);
compare("HITTERS · woba·rawpoly(#2)", HITTER, true, RAWPOLY_HIT, RAWPOLY_PIT);
compare("HITTERS · woba (log)", HITTER, true, LOG_HIT, LOG_PIT);
compare("PITCHERS · woba·rawpoly(#2)", PITCHER, false, RAWPOLY_HIT, RAWPOLY_PIT);
compare("PITCHERS · woba (log)", PITCHER, false, LOG_HIT, LOG_PIT);
