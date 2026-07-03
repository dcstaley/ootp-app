// The ONE roster-set → E[win%] entry point. Consumes a SELECTED set of hitters + pitchers
// (not a solved Roster), so the marginal-exchange selector and the benchmark both score
// candidate sets through exactly this path. Offense is availability-weighted (offense.ts);
// defense is the rotation + bullpen allowed-wOBA over their BF usage. One scoring core: the
// per-card values come from D2; nothing is re-scored here.

import type { HitterCandidate, PitcherCandidate, RosterOptimizeOptions } from "../optimizer/types.ts";
import { lineupPositions, qualifiesStarter, blendPitch } from "../optimizer/types.ts";
import { TARGET_WOBA } from "../scoring-core/calibrate.ts";
import { offenseRunsAboveAvg } from "./offense.ts";
import { defaultUsage, winPctFromRuns, DEFAULT_WIN_PARAMS, type WinParams, type WinBreakdown, type Usage } from "./expected-wins.ts";

/** The usage model for a roster shape + the Tier-1 usage knobs. Cheap; safe to call per eval. */
export function buildUsage(opts: RosterOptimizeOptions, p: WinParams): Usage {
  return defaultUsage(
    { lineupSize: lineupPositions(opts.dh).length, rotationSize: opts.minStarters, bullpenSize: Math.max(opts.nPitchers - opts.minStarters, 1) },
    6200, 6200, p.rotationShare, p.rotationDecay, opts.bestOf ?? 7, p.bullpenLeverage,
  );
}

/** Runs prevented above average by the staff (rotation + bullpen over their BF); null if the set
 *  can't staff the rotation. Independent of the hitters — so a hitter swap can reuse it. */
export function defenseRunsAboveAvg(pitchers: PitcherCandidate[], opts: RosterOptimizeOptions, usage: Usage, p: WinParams): number | null {
  const vSP = (c: PitcherCandidate) => blendPitch(c.valueVR, c.valueVL, c.throws, "sp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);
  const vRP = (c: PitcherCandidate) => blendPitch(c.valueVR, c.valueVL, c.throws, "rp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);
  const qualified = pitchers.filter((c) => qualifiesStarter(c, opts.minStarterStamina, opts.minPitchTypes));
  if (qualified.length < opts.minStarters) return null;
  const rotation = [...qualified].sort((a, b) => vSP(b) - vSP(a)).slice(0, opts.minStarters);
  const rotIds = new Set(rotation.map((c) => c.id));
  // Sort the bullpen best-first so the closer's leverage slot (bullpenBF[0]) goes to the best arm.
  const bullpen = pitchers.filter((c) => !rotIds.has(c.id)).sort((a, b) => vRP(b) - vRP(a));
  let def = 0;
  rotation.forEach((c, k) => { def += ((p.lgWoba - (TARGET_WOBA - vSP(c))) * (usage.rotationBF[k] ?? 0)) / p.wobaScale; });
  bullpen.forEach((c, k) => { def += ((p.lgWoba - (TARGET_WOBA - vRP(c))) * (usage.bullpenBF[k] ?? 0)) / p.wobaScale; });
  return def;
}

/** E[win%] for a selected set; null if the set can't field a lineup or staff the rotation.
 *  Offense (availability, expensive) and defense are separable — the climb evaluates them
 *  independently so an unchanged side can be reused when only one side changes. */
export function setExpectedWins(
  hitters: HitterCandidate[], pitchers: PitcherCandidate[], opts: RosterOptimizeOptions, p: WinParams = DEFAULT_WIN_PARAMS,
): WinBreakdown | null {
  const usage = buildUsage(opts, p);
  const off = offenseRunsAboveAvg(hitters, opts, usage, p);
  if (off == null) return null;
  const def = defenseRunsAboveAvg(pitchers, opts, usage, p);
  if (def == null) return null;
  return winPctFromRuns(off, def, p);
}
