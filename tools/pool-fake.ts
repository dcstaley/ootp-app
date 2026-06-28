// DIAGNOSTIC (pool-adjustment leverage) — does the re-scaling decision have TEETH at
// a BIG gap? Real pools differ ~0.3σ so transfer can't show leverage. Synthesize a
// weak pool by scaling every rating MULTIPLICATIVELY (×(1−frac); 40% weaker = ×0.6),
// which compresses the gaps between players (×0.6 of a 25-pt gap = 15) — the correct
// reading of "X% weaker" (and a clean additive shift in the model's ln space). Then
// predict each fake player WITH re-scaling (= scale back → original) vs WITHOUT (raw
// on the weak ratings). No ground truth → leverage/sensitivity, not validation:
// "how much does the decision move predictions", and — for our use — "does it change
// the RANKING" (Spearman). Spearman≈1 ⇒ can't change within-pool roster picks.
//
// Run: node tools/pool-fake.ts

import { existsSync } from "node:fs";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { spearman } from "../src/training/fit.ts";
import { wPearson } from "../src/training/metrics.ts";
import { LOG_HIT, LOG_PIT, RAWPOLY_HIT, RAWPOLY_PIT, fitHitForm, predictHitForm, fitPitForm, predictPitForm, type HitForm, type PitForm } from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const REAL = loadWindow(DIR, [2038, 2039]).observations;
const MIN_N = 600;
const HIT_SK = ["eye", "kRat", "pow", "babip", "gap"];
const PIT_SK = ["con", "stu", "hrr", "pbabip"];
const FRACS = [0.2, 0.4];

const wmean = (v: number[], w: number[]) => v.reduce((s, x, i) => s + w[i]! * x, 0) / w.reduce((s, x) => s + x, 0);
const wsd = (v: number[], w: number[]) => { const m = wmean(v, w); return Math.sqrt(wmean(v.map((x) => (x - m) ** 2), w)); };

// Multiplicative weakening: scale every rating by (1−frac) → a "40% weaker" pool is
// ×0.6, which compresses the talent gaps (and floors at 1).
function weaken(o: TrainObs, frac: number, isHit: boolean): TrainObs {
  const f = 1 - frac;
  if (isHit) { const h = { ...o.ratings.hit } as unknown as Record<string, number>; for (const s of HIT_SK) h[s] = Math.max(h[s]! * f, 1); return { ...o, ratings: { ...o.ratings, hit: h as any } }; }
  const p = { ...o.ratings.pitch } as unknown as Record<string, number>; for (const s of PIT_SK) p[s] = Math.max(p[s]! * f, 1); return { ...o, ratings: { ...o.ratings, pitch: p as any } };
}

function run(label: string, isHit: boolean, hitForm: HitForm, pitForm: PitForm) {
  const obs = REAL.filter((o) => (isHit ? o.hit.PA : o.pitch.BF) >= MIN_N);
  const w = obs.map((o) => Math.pow(isHit ? o.hit.PA : o.pitch.BF, 0.75));
  const params = isHit ? fitHitForm(hitForm, obs) : fitPitForm(pitForm, obs);
  const pred = (o: TrainObs) => (isHit ? predictHitForm(params as any, o) : predictPitForm(params as any, o));
  const real = obs.map(pred);
  console.log(`\n== ${label} (n=${obs.length}; WITH re-scale = original wOBA, WITHOUT = raw on ×(1−frac) ratings) ==`);
  for (const frac of FRACS) {
    const fake = obs.map((o) => pred(weaken(o, frac, isHit)));
    const lvl = (wmean(fake, w) - wmean(real, w)) * 1000;
    console.log(`  ${(frac * 100).toFixed(0)}% weaker (×${(1 - frac).toFixed(1)}):  mean wOBA WITH=${wmean(real, w).toFixed(3)} WITHOUT=${wmean(fake, w).toFixed(3)} (${lvl >= 0 ? "+" : ""}${lvl.toFixed(0)} pts)   sd ${(wsd(real, w) * 1000).toFixed(1)}→${(wsd(fake, w) * 1000).toFixed(1)} pts   Spearman(with,without)=${spearman(real, fake).toFixed(4)}   gap-Pearson=${wPearson(real, fake, w).toFixed(4)}`);
  }
}

console.log(`pool-fake — base = real 2038-39 pool, weakened MULTIPLICATIVELY (×(1−frac), gaps compress)`);
console.log(`(Spearman≈1 ⇒ re-scaling can't change within-pool roster picks; gap-Pearson<1 ⇒ it changes cardinal/relative values)`);
for (const [mlabel, hf, pf] of [["log", LOG_HIT, LOG_PIT], ["rawpoly(#2)", RAWPOLY_HIT, RAWPOLY_PIT]] as [string, HitForm, PitForm][]) {
  run(`HITTERS · ${mlabel}`, true, hf, pf);
  run(`PITCHERS · ${mlabel}`, false, hf, pf);
}
