// Phase 2 of the cap/slots objective rework (docs/REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md):
// the run-environment core of the roster → expected-win% evaluator. This file is the pure
// runs → win% math + the playing-time usage model; the offense (availability-weighted lineup)
// and defense (rotation + bullpen) run-production live in offense.ts / set-eval.ts, which feed
// their run totals in here.
//
// ONE currency: RUNS. A wOBA point is worth the same runs whether a hitter creates it or a
// pitcher prevents it, so H/P balance is mechanical — no hitter/pitcher "emphasis" knob.
//
// Calibration NOTE: roster *ranking* is invariant to `lgWoba`/`leagueRuns` up to a constant
// (team PA/BF are fixed by usage); they set the displayed win% level and mild Pythagorean
// curvature only. `wobaScale`, the usage weights, and `fullStrengthShare` drive relative value.

import { TARGET_WOBA } from "../scoring-core/calibrate.ts";

export interface WinParams {
  /** Runs per (wOBA point × PA). FanGraphs-standard wOBA scale ≈ 1.157. */
  wobaScale: number;
  /** The wOBA level counted as an "average" (competitive-opponent) team. Defaults to
   *  TARGET_WOBA (0.320): the scoring core anchors the top-50 cohort of BOTH pools there, so it
   *  is the elite-caliber benchmark a tournament actually faces and keeps H/P mutually
   *  consistent. Selection is invariant to it; it sets the displayed win% level. */
  lgWoba: number;
  /** R0: runs an average team scores (and allows) over the usage PA/BF budget. */
  leagueRuns: number;
  /** Pythagorean exponent for the run environment (~1.83; calibrate to OOTP). */
  pythExp: number;
  /** Fraction of games fielded at FULL strength (best nine available). The rest lose one
   *  starter to the best available re-matched replacement — this is what gives bench DEPTH
   *  value (a good bench cushions the loss). Tunable; higher for short tournaments. */
  fullStrengthShare: number;
  /** Platoon capture rate ρ ∈ (0,1]: how often a fielded card actually gets its favorable
   *  matchup. ρ<1 bleeds `(1−ρ)` of the off-side value in, curbing over-valuation of platoon
   *  specialists (ρ=1 = perfect deployment). Doubles as the Tier-1 platoon knob. */
  platoonCapture: number;
  /** Tier-1 BELIEF: the rotation↔bullpen INNINGS split (fraction of team BF thrown by starters).
   *  Zero-sum between the two pitching segments — this is "how are pitching innings divided", NOT
   *  "spend less on bullpen" (a budget preference = a Tier-2 cap, which lets the freed budget flow
   *  to hitters/bench/anywhere the optimizer wants). */
  rotationShare: number;
  /** Tier-1 BELIEF: rotation BF decay ∈ [0,1). 0 = every starter throws equally; higher tilts
   *  innings toward SP1 and away from the back end — this is "value the 5th starter less". */
  rotationDecay: number;
  /** Bullpen leverage premiums for the TOP relievers (closer, setup, …); every arm beyond the
   *  list is flat filler (weight 1). A tournament produces only a handful of high-leverage
   *  innings, so 1–2 good arms are worth real budget and the rest are interchangeable. The
   *  premiums are the "how good a closer" knob; the best rostered reliever gets slot 0. */
  bullpenLeverage: number[];
}

export const DEFAULT_WIN_PARAMS: WinParams = {
  wobaScale: 1.157, lgWoba: TARGET_WOBA, leagueRuns: 729, pythExp: 1.83,
  fullStrengthShare: 0.6, platoonCapture: 0.8, rotationShare: 0.62, rotationDecay: 0, bullpenLeverage: [2.5, 1.5],
};

export interface WinBreakdown {
  winPct: number;
  runsScored: number;
  runsAllowed: number;
  offRunsAboveAvg: number; // team offensive wRAA (availability-weighted)
  defRunsAboveAvg: number; // team runs prevented above average
}

/** Pure runs → win%: combine team offensive wRAA and runs-prevented into a Pythagorean win%. */
export function winPctFromRuns(offRunsAboveAvg: number, defRunsAboveAvg: number, p: WinParams = DEFAULT_WIN_PARAMS): WinBreakdown {
  const runsScored = p.leagueRuns + offRunsAboveAvg;
  const runsAllowed = p.leagueRuns - defRunsAboveAvg;
  const rs = Math.max(runsScored, 1e-6);
  const ra = Math.max(runsAllowed, 1e-6);
  const rsE = Math.pow(rs, p.pythExp);
  const winPct = rsE / (rsE + Math.pow(ra, p.pythExp));
  return { winPct, runsScored, runsAllowed, offRunsAboveAvg, defRunsAboveAvg };
}

// ── Usage model ───────────────────────────────────────────────────────────────
// The honest replacement for the old magic weights (slot decay / bullpenW / benchW):
// playing-time shares as actual PA/BF. Tournament-scoped; a defensible starting point —
// leverage-weighted bullpen BF and exact by-slot start counts are logged future refinements.

export interface RosterShape {
  lineupSize: number;    // batting slots contributing offense (8 or 9 with DH)
  rotationSize: number;  // starters
  bullpenSize: number;   // relievers
}

export interface Usage {
  lineupPA: number[];    // per batting-order slot
  rotationBF: number[];  // per rotation slot
  bullpenBF: number[];   // per bullpen arm
}

// ── Format-derived rotation usage (day-by-day simulation) ────────────────────────
// Caps/slots exist only for TOURNAMENTS (series play), so SP usage is set by the round format,
// not a guessed decay. The rule (per the domain): every game is a day; each day the HIGHEST-
// slotted SP that is fully rested (a full k-day cycle since its last start) starts; a series that
// clinches early leaves rest days (the unplayed games of the best-of-N) on which everyone rests
// and nobody starts; the rotation NEVER resets between series — the day count is continuous. Rest
// accumulated from short series lets the top of the rotation come back sooner, so it takes a
// larger share of starts; a format where every game is played (no rest) cycles evenly.

const binom = (nn: number, k: number): number => {
  if (k < 0 || k > nn) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1);
  return r;
};

/** Deterministic LCG (reproducible curve; no Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 0x100000000; };
}

/** Games actually played in a fair best-of-`bestOf` series for a uniform draw `q ∈ [0,1)`. */
function seriesLength(bestOf: number, q: number): number {
  const W = Math.ceil(bestOf / 2);
  let cum = 0;
  for (let g = W; g <= bestOf; g++) {
    cum += 2 * binom(g - 1, W - 1) * Math.pow(0.5, g); // P(series clinches in exactly g games)
    if (q < cum) return g;
  }
  return bestOf;
}

/**
 * Expected starts per rotation slot over a deep tournament run of best-of-`bestOf` rounds with a
 * `k`-man rotation, by direct simulation of the usage rule above. Returns average starts per slot
 * per series. e.g. Bo7 5-man leans to SP1 but keeps SP5 real; Bo3 stays flatter across rounds
 * (short series → the cycle keeps advancing, so SP4/SP5 do pitch — never zero).
 */
export function rotationStarts(bestOf: number, k: number, rounds = 4000): number[] {
  const kk = Math.max(k, 1);
  const rand = lcg(0x9e3779b1);
  const starts = new Array(kk).fill(0);
  const lastStart = new Array(kk).fill(-kk); // everyone rested at the start
  const warmup = Math.floor(rounds / 10);
  let day = 0, counted = 0;
  for (let r = 0; r < rounds; r++) {
    const G = seriesLength(bestOf, rand());
    const active = r >= warmup;
    if (active) counted++;
    for (let g = 0; g < bestOf; g++) {
      day++;
      if (g >= G) continue; // rest day: everyone rests, nobody starts
      let pick = -1;
      for (let i = 0; i < kk; i++) if (day - lastStart[i]! >= kk) { pick = i; break; } // highest-slotted fully rested
      if (pick < 0) { let best = -1; for (let i = 0; i < kk; i++) if (day - lastStart[i]! > best) { best = day - lastStart[i]!; pick = i; } } // fallback: most rested
      lastStart[pick] = day;
      if (active) starts[pick]!++;
    }
  }
  return starts.map((s) => s / Math.max(counted, 1));
}

/**
 * Tournament usage.
 *  • Batting order: a gentle top-of-order lean (~3% decline per slot, ≈1.3:1), to `teamPA`.
 *  • Rotation: gets `rotationShare` of BF, split by the FORMAT's expected starts per slot
 *    (`bestOf`), so SP5 is modestly-but-not-zero used and SP1/SP2 gain in longer series.
 *    `rotationDecay` is an optional manual tilt on TOP of the format curve (0 = format only).
 *  • Bullpen splits the rest evenly (leverage weighting is the next refinement).
 */
export function defaultUsage(
  shape: RosterShape, teamPA = 6200, teamBF = 6200, rotationShare = 0.62, rotationDecay = 0, bestOf = 7, bullpenLeverage: number[] = [],
): Usage {
  const { lineupSize, rotationSize, bullpenSize } = shape;
  const rawW = Array.from({ length: Math.max(lineupSize, 1) }, (_, i) => 1 - 0.03 * i);
  const wSum = rawW.reduce((s, x) => s + x, 0) || 1;
  const lineupPA = rawW.map((w) => (w / wSum) * teamPA);

  const rotBF = teamBF * rotationShare;
  const penBF = teamBF - rotBF;
  const rot = Math.max(rotationSize, 1);
  const pen = Math.max(bullpenSize, 1);
  // Base = format-derived expected starts; rotationDecay applies an extra manual tilt to SP1.
  const base = rotationStarts(bestOf, rot);
  const rotW = base.map((w, k) => w * (1 - rotationDecay * (rot > 1 ? k / (rot - 1) : 0)));
  const rotWSum = rotW.reduce((s, x) => s + x, 0) || 1;
  const rotationBF = rotW.map((w) => (w / rotWSum) * rotBF);
  // Bullpen: leverage-weighted — the top arms (closer, setup) get the premiums, the rest are flat
  // filler (weight 1). Redistributes the SAME bullpen innings toward the top, so one good closer
  // carries real value and filler is interchangeable.
  const penW = Array.from({ length: pen }, (_, i) => bullpenLeverage[i] ?? 1);
  const penWSum = penW.reduce((s, x) => s + x, 0) || 1;
  const bullpenBF = penW.map((w) => (w / penWSum) * penBF);
  return { lineupPA, rotationBF, bullpenBF };
}

/** Team wRAA of a fielded lineup: best hitters bat most (sort wOBA desc against the PA curve). */
export function lineupWraa(woba: number[], lineupPA: number[], p: WinParams): number {
  const sorted = [...woba].sort((a, b) => b - a);
  let s = 0;
  for (let i = 0; i < lineupPA.length; i++) s += ((sorted[i] ?? p.lgWoba) - p.lgWoba) * (lineupPA[i] ?? 0);
  return s / p.wobaScale;
}
