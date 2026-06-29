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
const WINDOW = [2037, 2038, 2039];
const MIN_N = 600, K = 5, TOPN = 26;
const PEL = loadWindowLeagues(DIR, WINDOW, ["PEL"]).observations;
const ALL = loadWindow(DIR, WINDOW).observations;

function compare(label: string, role: RoleSpec, isHit: boolean, hitForm: HitForm, pitForm: PitForm) {
  const fit = (obs: TrainObs[]) => (isHit ? fitHitForm(hitForm, obs) : fitPitForm(pitForm, obs));
  const pred = (p: any, o: TrainObs) => (isHit ? predictHitForm(p, o) : predictPitForm(p, o));
  const pelQ = PEL.filter((o) => role.qualifies(o, MIN_N));
  const allQ = ALL.filter((o) => role.qualifies(o, MIN_N));

  const fromPEL: number[] = [], fromALL: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < K; f++) {
    const testPEL = pelQ.filter((o) => foldOf(o.key, K) === f);
    if (!testPEL.length) continue;
    const testKeys = new Set(testPEL.map((o) => o.key));
    const trainPEL = pelQ.filter((o) => !testKeys.has(o.key));
    const trainALL = allQ.filter((o) => !testKeys.has(o.key)); // test cards fully excluded
    if (trainPEL.length < 10 || trainALL.length < 10) continue;
    const mPEL = fit(trainPEL), mALL = fit(trainALL);
    testPEL.forEach((o) => { fromPEL.push(pred(mPEL, o)); fromALL.push(pred(mALL, o)); actual.push(role.actualWoba(o)); weight.push(role.weight(o)); });
  }
  const pPEL = evalMetrics(fromPEL, actual, weight, role.higherBetter, TOPN).pearson;
  const pALL = evalMetrics(fromALL, actual, weight, role.higherBetter, TOPN).pearson;

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
  console.log(`\n== ${label} ==  (PEL N=${pelQ.length}, ALL N=${allQ.length})`);
  console.log(`  train PEL → predict PEL:  ${pPEL.toFixed(4)}`);
  console.log(`  train ALL → predict PEL:  ${pALL.toFixed(4)}   (Δ ALL−PEL = ${d >= 0 ? "+" : ""}${d.toFixed(4)} — negative ⇒ pooling HD hurts PEL)`);
  console.log(`  [ref] train ALL → predict ALL:  ${pAllAll.toFixed(4)}`);
}

console.log(`per-league-fit — window ${WINDOW.join("+")}, minN=${MIN_N}, ${K}-fold by card key; weighted Pearson`);
compare("HITTERS · woba·rawpoly(#2)", HITTER, true, RAWPOLY_HIT, RAWPOLY_PIT);
compare("HITTERS · woba (log)", HITTER, true, LOG_HIT, LOG_PIT);
compare("PITCHERS · woba·rawpoly(#2)", PITCHER, false, RAWPOLY_HIT, RAWPOLY_PIT);
compare("PITCHERS · woba (log)", PITCHER, false, LOG_HIT, LOG_PIT);
