// C4 — LOW-K-SUPPORT DISPLAY FLAG. Informational marker for a pitcher whose effective Stuff sits
// below the 5th percentile of the deployed K curve's league training support.
//
// What these pins protect:
//   1) THE THRESHOLD IS MODEL-SCOPED AND FINITE. It is the BF^0.75-weighted p05 of Stuff over the
//      rows the K curve was fit on (`pitch.BF >= minPA`) — the trainer's own row selection and
//      weighting. It must not depend on a tournament, a pool, or a card, and it must reproduce.
//   2) THE FLAG SEPARATES. A sub-p05 pitcher flags true; a mid-pack pitcher flags false. The card
//      coordinate is the transformed one (applyAffine through the pool transform), so a weak-pool
//      lift can legitimately carry a card back over the line — that is the point of the flag, not
//      a defect, and it is pinned here so it stays deliberate.
//   3) IT IS NON-SCORING. Two guards: a behavioral one (scoring a card is BIT-IDENTICAL whether or
//      not the flag path runs) and a STRUCTURAL one (no scoring-core / model / optimizer source
//      imports the flag module or mentions the flag field — a value assertion cannot catch a
//      future wiring mistake, a source scan can).
//
// All fixtures are synthetic (committed _synthetic.json coeffs + a hand-built log form) — no
// training data, no tournament data, fully deterministic.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  computeKSupport, effectiveStuff, isLowKSupport, supportPercentile, pitcherSideWeights,
  LOW_SUPPORT_Q, LADDER_N, type KSupportObs,
} from "../src/model/k-support.ts";
import { scoreCard, computeDerived, buildPoolTransform, type Coeffs, type CalScales, type FieldStats, type PoolTransform } from "../src/scoring-core/index.ts";
import type { RatingStats } from "../src/model/pool-transform.ts";

const synthCoeffs = (): Coeffs => JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
const IDENTITY: CalScales = {
  hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1,
  pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1,
  ssp_adv_hitting: 1, ssp_basic_pitching: 1,
};

/** A training observation, in the minimal shape computeKSupport reads (TrainObs satisfies it). */
const obs = (stu: number, BF: number): KSupportObs => ({ pitch: { BF }, ratings: { pitch: { stu } } });
/** The K curve's stored centering/scale (only mu/sd are read — the flag never evaluates the curve). */
const CURVE = { mu: 130, sd: 20 };

function card(over: Record<string, number> = {}): Record<string, unknown> {
  const base: Record<string, number> = {
    Eye: 110, Power: 130, "Avoid K": 95, BABIP: 105, Gap: 120,
    Control: 100, Stuff: 140, pBABIP: 90, pHR: 110, ...over,
  };
  const c: Record<string, unknown> = {
    "Card ID": `ks-${JSON.stringify(over)}`, "//Card Title": "k-support sample", "Card Value": 80,
    Bats: 1, Throws: 1, Speed: 40, Stealing: 30, Baserunning: 45, "Steal Rate": 50, Hold: 0, GB: 2,
    Stamina: 55, "Pitcher Role": 1, Position: 1,
  };
  for (const col of ["Eye", "Power", "Avoid K", "BABIP", "Gap", "Control", "Stuff", "pBABIP", "pHR"]) {
    for (const side of ["vR", "vL"]) c[`${col} ${side}`] = base[col];
  }
  return c;
}

// ── 1) the threshold ───────────────────────────────────────────────────────────
describe("computeKSupport — the model-scoped league training support", () => {
  // 100 equally-weighted observations at stuff 1…100 ⇒ the weighted p05 is the 5th value.
  const flat = Array.from({ length: 100 }, (_, i) => obs(i + 1, 1000));

  it("is finite, reproducible, and reads the weighted p05 of the fit rows", () => {
    const ks = computeKSupport(flat, 1000, CURVE)!;
    expect(ks).not.toBeNull();
    expect(ks.q).toBe(LOW_SUPPORT_Q);
    expect(Number.isFinite(ks.stuff)).toBe(true);
    expect(Number.isFinite(ks.z)).toBe(true);
    expect(ks.stuff).toBe(5);
    expect(ks.z).toBe((5 - CURVE.mu) / CURVE.sd);
    expect(ks.nObs).toBe(100);
    expect(ks.ladder).toHaveLength(LADDER_N);
    // deterministic: same rows + same curve ⇒ the identical object
    expect(computeKSupport(flat, 1000, CURVE)).toEqual(ks);
  });

  it("applies the TRAINER's row floor (BF >= minPA) — sub-floor rows never enter the support", () => {
    const withGhosts = [...flat, ...Array.from({ length: 40 }, () => obs(1, 5))]; // 40 tiny-BF rows at the very bottom
    const ks = computeKSupport(withGhosts, 1000, CURVE)!;
    expect(ks.nObs).toBe(100);      // the sub-floor rows are gone…
    expect(ks.stuff).toBe(5);       // …so they cannot drag the threshold down
  });

  it("weights by BF^0.75 (volume moves the percentile, count alone does not)", () => {
    // Same 100 stuff values, but the bottom 20 carry ~180× the weight each (10000^.75 / 1000^.75).
    const weighted = flat.map((o) => obs(o.ratings.pitch.stu, o.ratings.pitch.stu <= 20 ? 1_000_000 : 1000));
    const ks = computeKSupport(weighted, 1000, CURVE)!;
    expect(ks.stuff).toBeLessThan(computeKSupport(flat, 1000, CURVE)!.stuff + 1);
    expect(ks.stuff).toBeGreaterThan(0);
    expect(ks.stuff).toBeLessThanOrEqual(20); // the p05 now sits inside the heavy low block
  });

  it("is a property of the MODEL, not of a tournament: the support is the fit rows; the curve only restates it in z", () => {
    const a = computeKSupport(flat, 1000, CURVE)!;
    const b = computeKSupport(flat, 1000, { mu: 90, sd: 10 })!;
    expect(b.stuff).toBe(a.stuff);                 // same rows ⇒ same threshold
    expect(b.z).not.toBe(a.z);                     // a different curve only rescales the reading
    expect(b.z).toBe((a.stuff - 90) / 10);
  });

  it("returns null when there is nothing to measure (no qualifying rows)", () => {
    expect(computeKSupport([], 1000, CURVE)).toBeNull();
    expect(computeKSupport(flat, 10_000_000, CURVE)).toBeNull();
  });
});

// ── 2) the flag ────────────────────────────────────────────────────────────────
describe("isLowKSupport — a sub-p05 pitcher flags, a mid-pack pitcher does not", () => {
  const flat = Array.from({ length: 100 }, (_, i) => obs(i + 1, 1000));
  const ks = computeKSupport(flat, 1000, CURVE)!; // threshold = stuff 5 … using a realistic scale below

  // A realistic support: stuff 60…160, equal weight ⇒ p05 ≈ 65.
  const league = Array.from({ length: 101 }, (_, i) => obs(60 + i, 1000));
  const support = computeKSupport(league, 1000, CURVE)!;

  it("marks below the threshold and only below it", () => {
    expect(support.stuff).toBe(65);
    expect(isLowKSupport(support, 64.9)).toBe(true);
    expect(isLowKSupport(support, 65)).toBe(false);   // AT the p05 is supported (strictly below marks)
    expect(isLowKSupport(support, 110)).toBe(false);
    expect(isLowKSupport(support, NaN)).toBe(false);  // no coordinate ⇒ no claim
    expect(ks.stuff).toBe(5);                          // (the flat fixture is unchanged by the above)
  });

  it("uses the TRANSFORMED coordinate: effective Stuff is applyAffine per side, exposure-blended", () => {
    const weak = card({ Stuff: 62 }), mid = card({ Stuff: 120 });
    const wR = pitcherSideWeights(1, { r_pitch_split: 0.45, l_pitch_split: 0.25 });
    expect(wR.wR + wR.wL).toBeCloseTo(1, 12);
    // No transform ⇒ the raw rating (applyAffine identity).
    expect(effectiveStuff(weak, undefined, wR)).toBe(62);
    expect(isLowKSupport(support, effectiveStuff(weak, undefined, wR))).toBe(true);
    expect(isLowKSupport(support, effectiveStuff(mid, undefined, wR))).toBe(false);
    // A real weak-pool lift raises the coordinate — a card CAN cross back into support. That is
    // the flag's intent (the lift re-bases the pool toward the league frame), pinned deliberately.
    const st = (mu: number): RatingStats => ({ mu, sd: 10 });
    const mkField = (pit: number[]): FieldStats => {
      const h: Record<string, RatingStats> = {}, p: Record<string, RatingStats> = {};
      (["eye", "pow", "kRat", "babip", "gap"] as const).forEach((k) => { h[k] = st(120); });
      (["con", "stu", "pbabip", "hrr"] as const).forEach((k, i) => { p[k] = st(pit[i]!); });
      return { hit: { vR: h, vL: h }, pit: { vR: p, vL: p } };
    };
    const lift = buildPoolTransform(mkField([130, 160, 120, 140]), mkField([100, 100, 92, 110]));
    const lifted = effectiveStuff(weak, lift, wR);
    expect(lifted).toBeGreaterThan(62);
    expect(isLowKSupport(support, lifted)).toBe(false); // lifted back into the supported region
  });

  it("supportPercentile reports where the card sits (0 at/below the bottom, ~100 at the top)", () => {
    expect(supportPercentile(support, 59)).toBe(0);
    expect(supportPercentile(support, 160)).toBe(100);
    const mid = supportPercentile(support, 110);
    expect(mid).toBeGreaterThan(40);
    expect(mid).toBeLessThan(60);
    expect(supportPercentile(support, 64)).toBeLessThan(5); // below p05, as the flag says
  });
});

// ── 3) NON-SCORING — behavioral + structural ───────────────────────────────────
describe("the flag is NON-SCORING", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs);
  const EMPTY_PT: PoolTransform = { hit: { vR: {}, vL: {} }, pit: { vR: {}, vL: {} } };
  const league = Array.from({ length: 101 }, (_, i) => obs(60 + i, 1000));
  const support = computeKSupport(league, 1000, CURVE)!;

  it("scoring a card is BIT-IDENTICAL with and without the flag path", () => {
    const c = card({ Stuff: 62 }); // a card the flag DOES mark
    const before = scoreCard(c, { coeffs, derived, calScales: IDENTITY, poolTransform: EMPTY_PT });
    // …run the entire flag pipeline over the same card + config…
    const eff = effectiveStuff(c, EMPTY_PT, pitcherSideWeights(1, coeffs));
    const flag = isLowKSupport(support, eff);
    const pct = supportPercentile(support, eff);
    expect(flag).toBe(true);           // the flag really did fire (otherwise this test proves nothing)
    expect(pct).toBeLessThan(5);
    const after = scoreCard(c, { coeffs, derived, calScales: IDENTITY, poolTransform: EMPTY_PT });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).toEqual(before);
  });

  it("no scoring/model/optimizer/eval source imports the flag module or reads the flag field", () => {
    const tsFiles = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) tsFiles(p, out);
        else if (/\.tsx?$/.test(e)) out.push(p);
      }
      return out;
    };
    const scoringPaths = ["src/scoring-core", "src/optimizer", "src/config", "src/eval"].flatMap((d) => tsFiles(d));
    const offenders = scoringPaths.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /k-support\.ts/.test(src) || /lowKSupport|isLowKSupport|supportPercentile|kSupportPct/.test(src);
    });
    expect(offenders, `flag machinery reached a scoring path: ${offenders.join(", ")}`).toHaveLength(0);
    // src/model/k-support.ts itself must stay a LEAF of the scoring graph: it may read the pool
    // transform, but nothing in the scoring core may depend on it.
    const self = readFileSync("src/model/k-support.ts", "utf8");
    expect(/from "\.\.\/scoring-core/.test(self)).toBe(false);
    expect(/from "\.\.\/training/.test(self)).toBe(false);
  });
});
