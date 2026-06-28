// DIAGNOSTIC (pool-adjustment leverage) — does the re-scaling mechanism have TEETH
// at a BIG pool gap? Real pools differ by only ~0.3σ, so the transfer test couldn't
// show leverage. Here we synthesize a deliberately weak pool: take the real recent
// pool (2038-39) and shift every rating DOWN per skill so the pool is X% weaker on
// average (a pure level shift → identical "shape", just worse). Then predict each
// fake player's wOBA two ways:
//   WITH re-scaling  = re-center the weak pool back to the real mean → recovers the
//                      original ratings exactly → original prediction.
//   WITHOUT          = feed the weak ratings raw (model thinks they're genuinely bad).
// No ground truth (fake players) so this is a LEVERAGE/sensitivity probe, not a
// validation: it answers "how much does the re-scaling DECISION move predictions",
// and — critically for our use — "does it change the RANKING" (Spearman). If rank is
// preserved, re-scaling can't change within-pool roster picks however big the gap.
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

function weaken(o: TrainObs, frac: number, means: Record<string, number>, isHit: boolean): TrainObs {
  if (isHit) { const h = { ...o.ratings.hit } as Record<string, number>; for (const s of HIT_SK) h[s] = Math.max(h[s]! - frac * means[s]!, 1); return { ...o, ratings: { ...o.ratings, hit: h as any } }; }
  const p = { ...o.ratings.pitch } as Record<string, number>; for (const s of PIT_SK) p[s] = Math.max(p[s]! - frac * means[s]!, 1); return { ...o, ratings: { ...o.ratings, pitch: p as any } };
}

function run(label: string, isHit: boolean, hitForm: HitForm, pitForm: PitForm) {
  const obs = REAL.filter((o) => (isHit ? o.hit.PA : o.pitch.BF) >= MIN_N);
  const w = obs.map((o) => Math.pow(isHit ? o.hit.PA : o.pitch.BF, 0.75));
  const skills = isHit ? HIT_SK : PIT_SK, getR = (o: TrainObs, s: string) => ((isHit ? o.ratings.hit : o.ratings.pitch) as unknown as Record<string, number>)[s]!;
  const means = Object.fromEntries(skills.map((s) => [s, wmean(obs.map((o) => getR(o, s)), w)]));
  const params = isHit ? fitHitForm(hitForm, obs) : fitPitForm(pitForm, obs);
  const pred = (o: TrainObs) => (isHit ? predictHitForm(params as any, o) : predictPitForm(params as any, o));
  const real = obs.map(pred);
  console.log(`\n== ${label} (n=${obs.length}; WITH re-scale = original wOBA, WITHOUT = raw on weakened ratings) ==`);
  for (const frac of FRACS) {
    const fake = obs.map((o) => pred(weaken(o, frac, means, isHit)));
    const lvl = (wmean(fake, w) - wmean(real, w)) * 1000;
    console.log(`  ${(frac * 100).toFixed(0)}% weaker:  mean wOBA WITH=${wmean(real, w).toFixed(3)} WITHOUT=${wmean(fake, w).toFixed(3)} (${lvl >= 0 ? "+" : ""}${lvl.toFixed(0)} pts)   sd ${(wsd(real, w) * 1000).toFixed(1)}→${(wsd(fake, w) * 1000).toFixed(1)} pts   Spearman(with,without)=${spearman(real, fake).toFixed(4)}   gap-Pearson=${wPearson(real, fake, w).toFixed(4)}`);
  }
}

console.log(`pool-fake — base = real 2038-39 pool, weakened by a pure per-skill level shift (shape preserved)`);
console.log(`(Spearman≈1 ⇒ re-scaling can't change within-pool roster picks; gap-Pearson<1 ⇒ it changes cardinal/relative-gap values)`);
for (const [mlabel, hf, pf] of [["log", LOG_HIT, LOG_PIT], ["rawpoly(#2)", RAWPOLY_HIT, RAWPOLY_PIT]] as [string, HitForm, PitForm][]) {
  run(`HITTERS · ${mlabel}`, true, hf, pf);
  run(`PITCHERS · ${mlabel}`, false, hf, pf);
}
