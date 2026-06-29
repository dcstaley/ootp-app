// DIAGNOSTIC — how many years back is it worth training on? Drift continues, so an
// ever-growing window must eventually go stale. Test: predict the NEWEST year (2040)
// from progressively longer lookbacks; find where prediction stops improving (plateau
// ⇒ diminishing returns, stable mapping) or degrades (⇒ staleness cutoff). Clean OOT:
// test = 2040 qualified cards; any card also present in 2040 is EXCLUDED from training
// (no card overlap → no leakage), and the 2040 test set is FIXED across all windows.
// All leagues (settled). Note the 2034-36 gap in the data.
//
// Run: node tools/window-length.ts

import { existsSync } from "node:fs";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { HITTER, PITCHER, type RoleSpec } from "../src/training/bakeoff.ts";
import { RAWPOLY_HIT, RAWPOLY_PIT, fitHitForm, predictHitForm, fitPitForm, predictPitForm } from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const TEST_YEAR = 2040, MIN_N = 600, TOPN = 26;
const WINDOWS = [[2039], [2038, 2039], [2037, 2038, 2039], [2033, 2037, 2038, 2039], [2032, 2033, 2037, 2038, 2039]];
const test = loadWindow(DIR, [TEST_YEAR]).observations;

function run(label: string, role: RoleSpec, isHit: boolean) {
  const fit = (obs: TrainObs[]) => (isHit ? fitHitForm(RAWPOLY_HIT, obs) : fitPitForm(RAWPOLY_PIT, obs));
  const pred = (p: any, o: TrainObs) => (isHit ? predictHitForm(p, o) : predictPitForm(p, o));
  const testQ = test.filter((o) => role.qualifies(o, MIN_N));
  const testKeys = new Set(testQ.map((o) => o.key));
  const actual = testQ.map(role.actualWoba), weight = testQ.map((o) => role.weight(o));
  console.log(`\n== ${label} ==  (predict ${TEST_YEAR}, test N=${testQ.length})`);
  for (const W of WINDOWS) {
    const train = loadWindow(DIR, W).observations.filter((o) => role.qualifies(o, MIN_N) && !testKeys.has(o.key));
    if (train.length < 10) { console.log(`  train ${W.join("+").padEnd(24)} N=${train.length}  (too few)`); continue; }
    const m = fit(train);
    const p = evalMetrics(testQ.map((o) => pred(m, o)), actual, weight, role.higherBetter, TOPN).pearson;
    console.log(`  train ${W.join("+").padEnd(24)} N=${String(train.length).padStart(3)}  →  Pearson=${p.toFixed(4)}`);
  }
}

console.log(`window-length — predict ${TEST_YEAR} from expanding lookbacks (all leagues, #2 rawpoly, minN=${MIN_N})`);
run("HITTERS", HITTER, true);
run("PITCHERS", PITCHER, false);
