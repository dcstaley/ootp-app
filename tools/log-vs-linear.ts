// DIAGNOSTIC — is log actually better than raw-linear across the rating terms, or is
// the per-term "log wins by a hair" just noise? Two cuts:
//   1) the WHOLE form: all-log vs all-linear (every rating term incl H-rating & BIP).
//   2) each term flipped BOTH ways: from the all-log base (term→linear) AND from the
//      all-linear base (term→log). A real log preference should show up from BOTH
//      sides; if it flips with the baseline, it's context/noise.
// Plus a NOISE-FLOOR read: the same all-log form's CV Pearson at k=5/8/10 — if the
// baseline wiggles more than the log-vs-linear gaps, the gaps are noise.
//
// Run: node tools/log-vs-linear.ts

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { foldOf } from "../src/training/evaluate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { HITTER, PITCHER, type RoleSpec } from "../src/training/bakeoff.ts";
import { fitHitForm, predictHitForm, fitPitForm, predictPitForm, type HitForm, type PitForm, type Curve } from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const obs = loadWindow(DIR, availableYears(DIR).slice(-2)).observations;
const LOG: Curve = { kind: "log" }, LIN: Curve = { kind: "rawpoly", degree: 1 };
const MIN_N = 1000, TOPN = 26;

function cv(form: HitForm | PitForm, role: RoleSpec, isHit: boolean, k = 5): number {
  const qual = obs.filter((o) => role.qualifies(o, MIN_N));
  const pred: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < k; f++) {
    const test = qual.filter((o) => foldOf(o.key, k) === f), train = qual.filter((o) => foldOf(o.key, k) !== f);
    if (!test.length || train.length < 10) continue;
    const p = isHit ? fitHitForm(form as HitForm, train) : fitPitForm(form as PitForm, train);
    test.forEach((o) => { pred.push(isHit ? predictHitForm(p as any, o) : predictPitForm(p as any, o)); actual.push(role.actualWoba(o)); weight.push(role.weight(o)); });
  }
  return evalMetrics(pred, actual, weight, role.higherBetter, TOPN).pearson;
}

const allLogHit: HitForm = { name: "", bb: LOG, k: LOG, hr: LOG, xbh: LOG, h: LOG, hBip: LOG };
const allLinHit: HitForm = { name: "", bb: LIN, k: LIN, hr: LIN, xbh: LIN, h: LIN, hBip: LIN };
const allLogPit: PitForm = { name: "", bb: LOG, k: LOG, hr: LOG, h: LOG, hBip: LOG };
const allLinPit: PitForm = { name: "", bb: LIN, k: LIN, hr: LIN, h: LIN, hBip: LIN };
const HTERMS: [string, keyof HitForm][] = [["BB", "bb"], ["K", "k"], ["HR", "hr"], ["XBH", "xbh"], ["BABIP", "h"], ["BIP", "hBip"]];
const PTERMS: [string, keyof PitForm][] = [["BB", "bb"], ["K", "k"], ["HR", "hr"], ["PBABIP", "h"], ["BIP", "hBip"]];

function report(label: string, role: RoleSpec, isHit: boolean, allLog: any, allLin: any, terms: [string, string][]) {
  const baseLog = cv(allLog, role, isHit), baseLin = cv(allLin, role, isHit);
  console.log(`\n== ${label} ==  ALL-LOG CV=${baseLog.toFixed(4)}   ALL-LINEAR CV=${baseLin.toFixed(4)}   (Δ=${(baseLog - baseLin >= 0 ? "+" : "") + (baseLog - baseLin).toFixed(4)} log−lin)`);
  console.log(`  per-term      from all-LOG (→lin)     from all-LINEAR (→log)`);
  for (const [name, key] of terms) {
    const fromLog = cv({ ...allLog, [key]: LIN }, role, isHit);   // make THIS term linear
    const fromLin = cv({ ...allLin, [key]: LOG }, role, isHit);   // make THIS term log
    const dL = fromLog - baseLog, dN = fromLin - baseLin;
    console.log(`  ${name.padEnd(7)}  lin=${fromLog.toFixed(4)} (Δ${dL >= 0 ? "+" : ""}${dL.toFixed(4)})   log=${fromLin.toFixed(4)} (Δ${dN >= 0 ? "+" : ""}${dN.toFixed(4)})`);
  }
  const nz = [5, 8, 10].map((k) => cv(allLog, role, isHit, k).toFixed(4));
  console.log(`  noise floor (ALL-LOG CV @ k=5/8/10): ${nz.join(" / ")}`);
}

console.log(`log-vs-linear — window=${availableYears(DIR).slice(-2).join("+")}, minN=${MIN_N}, weighted Pearson`);
report("HITTERS", HITTER, true, allLogHit, allLinHit, HTERMS);
report("PITCHERS", PITCHER, false, allLogPit, allLinPit, PTERMS);
