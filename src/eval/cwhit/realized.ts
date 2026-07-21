// ═══ REALIZED USAGE — THE ONE COPY ═══════════════════════════════════════════
//
// WHAT THIS EXISTS TO FIX. The battery's realized-usage work (items 1-realized and 4) joined the
// observed capture tables to the catalog with a private hand-rolled parse restricted to observed
// `VLvl == 0`. That silently DROPPED every v5 variant row — 785 of 3078 observed rows, 25.5% of all
// observed play, concentrated in the best cards — so "the field actually faced" was measured over a
// field that excluded a quarter of it, and excluded it non-randomly.
//
// TWO SEPARATE DEFECTS WERE IN THAT ONE STEP:
//  1. VARIANT BLINDNESS. Variants are generated at runtime (`makeVariant`) and absent from the
//     catalog CSV, so a tool that reads the CSV and joins on name has nothing to match a v5 row to.
//     The BUILDER already solves this — it constructs base (VLvl 0) + v5 (VLvl 5) per card and joins
//     each separately (sample.ts, "our side" loop) — the private joins simply did not use it.
//  2. A PRIVATE JOIN. Name+VAL+Hand equality is not the program's join: `joinCwhit` disambiguates
//     collisions on an event-space fingerprint, and ruling B pinned that the fingerprint must be
//     built from the UNCORRECTED line. A hand-rolled key map reproduces neither property.
//
// SO THIS MODULE DOES NOT JOIN. It reads usage off a `SampleResult` the builder already produced,
// keyed by `Rec.cid` = `${Card ID}|${vlvl}`, and pairs it with an opponent set built the SAME way the
// builder builds its card side. Variant handling is therefore not a feature of this file — it is
// inherited, which is the point.
//
// WHAT IS DELIBERATELY *NOT* CHANGED: the ELIGIBLE (uniform) side stays non-variant. That is not an
// oversight and not a second bug — it MIRRORS PRODUCTION, where the pool that sets the distribution
// is `basePool` (server.ts: "Variants are still scored ... they just don't set the distribution") and
// the builder's own pool reference is VLvl-0 only. The eligible side is the assumption under test; it
// has to be quoted as production computes it. Only the REALIZED side gains variants, because variants
// were genuinely played and their absence is a measurement error rather than a modelling convention.

import type { Card } from "../../data/catalog.ts";
import { makeVariant } from "../../data/variants.ts";
import { inValueWindow, isPit, type Rec, type SampleResult, type ValueWindow } from "./sample.ts";

/** `${tier}|${role}` — the grain every realized quantity is measured at. */
export const cellKey = (tier: string, role: "pit" | "hit"): string => `${tier}|${role}`;

/** One candidate opponent: a catalog card at a specific variant level, with the identity the builder
 *  uses. `card` is the BASE row at vlvl 0 and the boosted `makeVariant` row at vlvl 5 — the ratings a
 *  prediction must be made from, which differ between the two. */
export interface Opponent { cid: string; card: Card; vlvl: number }

/** The candidate opponent set for one format × role: every eligible card at BOTH variant levels.
 *
 *  MIRRORS `buildCwhitSample`'s card-side loop EXACTLY (same order, same window test applied to the
 *  variant row itself, same cid). `tests/cwhit-realized.test.ts` pins that correspondence, so a future
 *  change to the builder's eligibility cannot silently desynchronise this set from the joined one. */
export function opponentSet(baseCards: Card[], win: ValueWindow, role: "pit" | "hit"): Opponent[] {
  const out: Opponent[] = [];
  for (const bc of baseCards) {
    for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (!inValueWindow(c, win)) continue;
      if (role === "pit" ? !isPit(c) : isPit(c)) continue;
      out.push({ cid: `${bc["Card ID"]}|${vlvl}`, card: c, vlvl });
    }
  }
  return out;
}

/** Realized usage by cid, per tier × role. Usage is `Rec.sample` — BF for pitchers, PA for hitters,
 *  i.e. OPPONENTS FACED on both sides, which is the quantity an opponent-field weighting wants.
 *
 *  NO FLOOR IS APPLIED. `wellSampled` is a reliability bar for judging a card's RATE; a card with 40
 *  PA still contributed 40 PA of opposition and its weight is 40. Filtering here would be a second,
 *  invisible selection on the weights. */
export function realizedUsage(res: SampleResult): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of res.recs) {
    const k = cellKey(r.tier, r.role);
    let m = out.get(k); if (!m) { m = new Map(); out.set(k, m); }
    m.set(r.cid, (m.get(r.cid) ?? 0) + r.sample);
  }
  return out;
}

export interface CoverageRow {
  tier: string; role: "pit" | "hit";
  /** eligible candidates at each variant level, and how many of each carry ANY observed usage */
  nBase: number; nVar: number; playedBase: number; playedVar: number;
  usageBase: number; usageVar: number;
  /** share of this cell's total realized usage carried by v5 rows — the quantity the old
   *  VLvl-0-only weighting was setting to zero */
  varShare: number;
  /** observed rows the builder matched that fall outside the opponent set (should be 0 — the two are
   *  built from the same catalog and window; a non-zero here means they have desynchronised) */
  orphanCids: number;
}

/** Per-cell coverage of the realized weighting, INCLUDING the variant share that the previous
 *  VLvl-0-only weighting discarded. Reported next to every result computed from these weights. */
export function coverage(
  usage: Map<string, Map<string, number>>, opponents: Map<string, Opponent[]>,
): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const [key, opps] of opponents) {
    const [tier, role] = key.split("|") as [string, "pit" | "hit"];
    const u = usage.get(key) ?? new Map<string, number>();
    const seen = new Set<string>();
    let nBase = 0, nVar = 0, playedBase = 0, playedVar = 0, usageBase = 0, usageVar = 0;
    for (const o of opps) {
      const w = u.get(o.cid) ?? 0;
      if (w > 0) seen.add(o.cid);
      if (o.vlvl === 0) { nBase++; if (w > 0) { playedBase++; usageBase += w; } }
      else { nVar++; if (w > 0) { playedVar++; usageVar += w; } }
    }
    let orphanCids = 0;
    for (const cid of u.keys()) if (!seen.has(cid)) orphanCids++;
    const tot = usageBase + usageVar;
    rows.push({ tier, role, nBase, nVar, playedBase, playedVar, usageBase, usageVar, varShare: tot > 0 ? usageVar / tot : NaN, orphanCids });
  }
  return rows;
}

/** Weight vector aligned to an opponent list; unplayed opponents get 0. */
export const weightsFor = (opps: Opponent[], u: Map<string, number> | undefined): number[] =>
  opps.map((o) => u?.get(o.cid) ?? 0);

/** Convenience: the matched recs of one cell, for observed-side work (item 5). */
export const cellRecs = (res: SampleResult, tier: string, role: "pit" | "hit"): Rec[] =>
  res.recs.filter((r) => r.tier === tier && r.role === role);
