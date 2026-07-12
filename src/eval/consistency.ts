// Cross-role consistency + frame-gap readout — a per-tournament ALARM, not a correction.
//
// Every PA has exactly one hitter and one pitcher, so over a closed set of games the
// hitter curve family's implied event totals and the pitcher curve family's implied
// ALLOWED totals must approximately agree. The two families are fitted independently
// (hitter ratings → line; pitcher ratings → allowed line), so away from the league
// training frame they can disagree wildly (observed: on a weak ≤69 pool the hitter
// curves implied 146 K/600 while the pitcher curves implied 93 — truth was 109).
// Divergence ⇒ at least one side is extrapolating badly.
//
// PROXY CAVEATS (why this is an alarm, not an identity check):
//   • The top-X hitters here don't literally face the top-X pitchers with real
//     deployment weights (lineup slots, staff usage, platoon exposure all differ),
//     so exact equality is NOT expected even in-frame.
//   • Therefore the useful signal is DIVERGENCE GROWTH vs the full-pool (reference)
//     baseline — the report carries both so the caller compares pool vs baseline —
//     not the absolute pool diff on its own.
//
// This module is PURE AGGREGATION of existing model outputs: raw (env-free) event
// predictions from the ONE event model, selected on the same raw-wOBA basis the
// pool/field machinery uses (cardSideWobas, pool-stats.ts). No scoring math lives here.
// Raw events are deliberately used (no era/park/calibration): those layers multiply
// both roles' rates through the same one-core recompute and would only blur the
// curve-extrapolation signal this readout exists to expose.

import type { Coeffs } from "../config/types.ts";
import type { EventModel } from "../model/types.ts";
import { HIT_RATINGS, PIT_RATINGS } from "../model/pool-transform.ts";
import { cardSideWobas, computeUnifiedFieldStats } from "../scoring-core/pool-stats.ts";
import { n } from "../scoring-core/helpers.ts";

export const CONSISTENCY_EVENTS = ["BB", "K", "HR", "1B", "XBH"] as const;
export type ConsistencyEvent = (typeof CONSISTENCY_EVENTS)[number];
type EventRates = Record<ConsistencyEvent, number>;

export interface EventReadout {
  hitterPer600: number;  // mean implied rate over the top-X hitters
  pitcherPer600: number; // mean implied ALLOWED rate over the top-X pitchers
  diffPer600: number;    // hitter − pitcher
  ratio: number;         // hitter / pitcher
}

export interface ChannelGap { refMu: number; poolMu: number; gap: number } // gap = ref − pool

export interface ConsistencyReport {
  topX: number;   // event-mean cohort size (optimizer pool convention)
  fieldN: number; // frame-gap field size (matches the server's pool-transform FIELD_N)
  poolCards: number;
  refCards: number;
  /** Pool readout — the alarm input. */
  events: Record<ConsistencyEvent, EventReadout>;
  /** Same computation over the reference (full) catalog — the baseline the pool's
   *  divergence is compared against (divergence GROWTH is the signal). */
  referenceEvents: Record<ConsistencyEvent, EventReadout>;
  maxAbsEventDiffPer600: number;          // over the pool events
  referenceMaxAbsEventDiffPer600: number; // over the reference events
  /** Per-rating-channel frame gaps: reference field mean − pool field mean.
   *  Gap magnitudes = "how far out of the training frame is this pool". */
  gaps: { hit: Record<string, ChannelGap>; pit: Record<string, ChannelGap> };
}

export interface ConsistencyOptions {
  topX?: number;   // default 100 — the optimizer pool convention (top-N by predicted wOBA; role never gates)
  fieldN?: number; // default 50 — the validated realistic-field size the pool transform uses
}

const r3 = (x: number) => Math.round(x * 1e3) / 1e3;

// Column readers mirror pool-stats.ts cardRec / the server debug traces (the shared
// CSV catalog shape). Reading columns is plumbing, not scoring — the events come
// straight from the one event model.
function hitEvents(c: Record<string, unknown>, side: "vR" | "vL", coeffs: Coeffs, model: EventModel): EventRates {
  const e = model.predictHitting({
    eye: n(c[`Eye ${side}`]), pow: n(c[`Power ${side}`]), kRat: n(c[`Avoid K ${side}`]),
    babip: n(c[`BABIP ${side}`]), gap: n(c[`Gap ${side}`]),
    speed: n(c["Speed"]), steal: n(c["Stealing"]), run: n(c["Baserunning"]),
  }, coeffs);
  return { BB: e.BB, K: e.SO, HR: e.HR, "1B": e.oneB, XBH: e.GAP };
}

function pitEvents(c: Record<string, unknown>, side: "vR" | "vL", coeffs: Coeffs, model: EventModel): EventRates {
  const e = model.predictPitching({
    con: n(c[`Control ${side}`]), stu: n(c[`Stuff ${side}`]),
    pbabip: n(c[`pBABIP ${side}`]), hrr: n(c[`pHR ${side}`]),
  }, coeffs);
  return { BB: e.BB, K: e.K, HR: e.HR, "1B": e.nHH - e.XBH, XBH: e.XBH };
}

function zeroRates(): EventRates { return { BB: 0, K: 0, HR: 0, "1B": 0, XBH: 0 }; }

/** Mean raw event rates over the top-X cards of one role, per-side cohorts averaged
 *  equally. Selection = raw predicted wOBA (cardSideWobas, sspFree — the same env-free
 *  basis the field/pool machinery ranks on; hitters highest, pitchers lowest allowed). */
function impliedMeanEvents(
  cards: Record<string, unknown>[], role: "hit" | "pit", coeffs: Coeffs, model: EventModel, topX: number,
): EventRates {
  const recs = cards.map((c) => ({ c, w: cardSideWobas(c, coeffs, model, true) }));
  const sideMean = (side: "vR" | "vL"): EventRates => {
    const k = `${role}${side === "vR" ? "VR" : "VL"}` as keyof ReturnType<typeof cardSideWobas>; // hitVR/hitVL/pitVR/pitVL
    const top = [...recs]
      .sort((a, b) => (role === "hit" ? b.w[k] - a.w[k] : a.w[k] - b.w[k]))
      .slice(0, topX);
    const acc = zeroRates();
    for (const { c } of top) {
      const e = role === "hit" ? hitEvents(c, side, coeffs, model) : pitEvents(c, side, coeffs, model);
      for (const ev of CONSISTENCY_EVENTS) acc[ev] += e[ev];
    }
    const m = Math.max(top.length, 1);
    for (const ev of CONSISTENCY_EVENTS) acc[ev] /= m;
    return acc;
  };
  // Equal vR/vL blend — a deployment-agnostic proxy (see header: real exposure weights
  // differ; the signal is divergence growth, so the blend just needs to be consistent).
  const vR = sideMean("vR"), vL = sideMean("vL");
  const out = zeroRates();
  for (const ev of CONSISTENCY_EVENTS) out[ev] = (vR[ev] + vL[ev]) / 2;
  return out;
}

function readout(hit: EventRates, pit: EventRates): Record<ConsistencyEvent, EventReadout> {
  const out = {} as Record<ConsistencyEvent, EventReadout>;
  for (const ev of CONSISTENCY_EVENTS) {
    const h = hit[ev], p = pit[ev];
    out[ev] = { hitterPer600: r3(h), pitcherPer600: r3(p), diffPer600: r3(h - p), ratio: p > 1e-9 ? r3(h / p) : 0 };
  }
  return out;
}

const maxAbsDiff = (ev: Record<ConsistencyEvent, EventReadout>) =>
  r3(Math.max(...CONSISTENCY_EVENTS.map((e) => Math.abs(ev[e].diffPer600))));

/** The standing per-tournament readout: cross-role implied event totals (pool vs the
 *  full-catalog baseline) + per-channel frame gaps. Raw ratings in, raw events out —
 *  the pool transform is deliberately NOT applied (the alarm measures how the curves
 *  behave on the pool as it actually is, i.e. the extrapolation the transform exists
 *  to mitigate). */
export function computeConsistency(
  poolCards: Record<string, unknown>[], refCards: Record<string, unknown>[],
  coeffs: Coeffs, model: EventModel, opts: ConsistencyOptions = {},
): ConsistencyReport {
  const topX = opts.topX ?? 100;
  const fieldN = opts.fieldN ?? 50;

  const events = readout(
    impliedMeanEvents(poolCards, "hit", coeffs, model, topX),
    impliedMeanEvents(poolCards, "pit", coeffs, model, topX),
  );
  const referenceEvents = readout(
    impliedMeanEvents(refCards, "hit", coeffs, model, topX),
    impliedMeanEvents(refCards, "pit", coeffs, model, topX),
  );

  // Frame gaps — the same unified field stats (and sspFree selection) the server's
  // pool-transform call sites use, at the same field size. Unified ⇒ vR === vL, read vR.
  const ref = computeUnifiedFieldStats(refCards, coeffs, model, fieldN, true);
  const pool = computeUnifiedFieldStats(poolCards, coeffs, model, fieldN, true);
  const gapBlock = (keys: readonly string[], r: Record<string, { mu: number }>, p: Record<string, { mu: number }>) => {
    const out: Record<string, ChannelGap> = {};
    for (const k of keys) {
      const rm = r[k]?.mu ?? 0, pm = p[k]?.mu ?? 0;
      out[k] = { refMu: r3(rm), poolMu: r3(pm), gap: r3(rm - pm) };
    }
    return out;
  };

  return {
    topX, fieldN, poolCards: poolCards.length, refCards: refCards.length,
    events, referenceEvents,
    maxAbsEventDiffPer600: maxAbsDiff(events),
    referenceMaxAbsEventDiffPer600: maxAbsDiff(referenceEvents),
    gaps: {
      hit: gapBlock(HIT_RATINGS, ref.hit.vR, pool.hit.vR),
      pit: gapBlock(PIT_RATINGS, ref.pit.vR, pool.pit.vR),
    },
  };
}
