// M3 (D4) — resolve a flat scoring `Coeffs` bag from its separable parts at the
// moment a tournament is selected. This is the "no Load-into-coefficients button"
// flow: pick a tournament → its Era + Park (from the libraries, by id) + its
// softcaps + the shared trained Model assemble into the bag the scoring core
// consumes. Built on the lossless split/assembleCoeffs partition, so a bag split
// into {model, era, park, softcaps} and resolved back is byte-identical — i.e.
// tournament-sourced config reproduces the captured scores exactly (parity gate).

import type { Coeffs } from "./types.ts";
import type { Era, Park, Softcaps } from "./tournament.ts";
import { assembleCoeffs, splitCoeffs, type EraFactors, type ParkFactors, type ModelCoeffs } from "./coeff-assembly.ts";

/**
 * A trained scoring model artifact (model-scoped, D3 seam). `coeffs` are the
 * trained coefficients; `extras` is the not-yet-categorised remainder of the bag
 * (ssp / splits / adv constants / league norms / position weights) that scoring
 * still reads. These are identical across a user's captures — one Model, many
 * tournaments. (Categorising the tournament-scoped bits of `extras` — e.g. the
 * `pw_*` position weights → tournament — and a richer artifact format are
 * follow-ups; this is the minimal shape the resolver needs.)
 */
export interface Model {
  id: string;
  name: string;
  coeffs: ModelCoeffs;
  extras: Record<string, number | boolean>;
}

const eraFactors = (e: Era): EraFactors => ({
  bb: e.bb, k: e.k, avg: e.avg, hr: e.hr, bip: e.bip, gap: e.gap,
  thr_toggle: e.thr_toggle, thr: e.thr ?? 1,
});

// Reference per-BIP non-HR-hit rate = era-2010's rates block ((h − hr) / bip), the library's
// baseline era (all era factors are ratios to 2010). Guarded by a test against the era file.
const REF_NHH_PER_BIP = (0.22944 - 0.02488) / 0.68832;

// ── Baserunning value (the ONE place) ──────────────────────────────────────────
// UBR (extra-base-taking) value per rating point, FIT on our league data (tools/baserunning-fit.ts:
// UBR/600 ~ Speed + Baserunning, β_speed 0.0177, β_run 0.0650 runs/600/pt) at the 2010-baseline run
// environment, converted runs/600 → wOBA/pt via the standard wOBA scale (1.25 runs/pt ÷ 600). Added
// to the hitter wOBA in woba.ts as adv_speed·Speed + adv_run·Baserunning, then era-scaled by runVal
// (run scarcity) in resolveCoeffs. adv_steal stays 0 — steal value is tendency×ability and needs a
// new scoring input (deferred). The BASIC-score path (w_speed/w_run) is a separate anchored scale
// (TARGET_BASIC 100 vs wOBA 0.320, log vs linear form) and is NOT wired here — a follow-up.
const WOBA_SCALE = 1.25;
const ADV_SPEED_UBR = 0.0177 * (WOBA_SCALE / 600); // ≈ 0.0000369 wOBA per Speed pt (2010 baseline)
const ADV_RUN_UBR = 0.0650 * (WOBA_SCALE / 600);   // ≈ 0.0001354 wOBA per Baserunning pt (2010 baseline)

/** Fields the per-BIP era factors read; a partial/malformed block silently produces Infinity/NaN
 *  factors (÷ bip, ÷ (h−hr)) → Infinity scores downstream. Validated at ingestion + resolve. */
const RATES_FIELDS = ["bb", "k", "hr", "h", "b2", "b3", "bip"] as const;

/**
 * Reject a partial/malformed era rates block LOUDLY rather than let it produce Infinity scores.
 * Requires every rate to be a finite number and the two divisors (bip, h−hr) to be strictly
 * positive. Called at BBRef ingestion (so a bad row never gets written) and defensively in
 * resolveCoeffs (so a hand-edited era file can't silently corrupt scoring).
 */
export function validateRates(rates: Partial<NonNullable<Era["rates"]>> | null | undefined, ctx = "era"): asserts rates is NonNullable<Era["rates"]> {
  if (!rates || typeof rates !== "object") throw new Error(`${ctx}: rates block missing or not an object`);
  const bad = RATES_FIELDS.filter((f) => !Number.isFinite((rates as any)[f]));
  if (bad.length) throw new Error(`${ctx}: rates block has non-finite/missing field(s): ${bad.join(", ")}`);
  if (rates.bip! <= 0) throw new Error(`${ctx}: rates.bip must be > 0 (got ${rates.bip})`);
  if (rates.h! - rates.hr! <= 0) throw new Error(`${ctx}: rates.h − rates.hr must be > 0 (got h=${rates.h}, hr=${rates.hr})`);
}

/** Per-BIP non-HR-hit era factor from an era's raw rates block: how an era moves hits PER
 *  BALL IN PLAY, not per PA. The per-PA `avg` double-counts the era's K/BB-driven BIP
 *  expansion when applied to the recompute's per-BIP hit chain (the dead-ball 1B
 *  over-prediction — plan doc §10: era-1920 configured era_h 1.152 vs 0.974 per-BIP,
 *  implied-by-actuals ≈1.0; sign flips for modern high-K eras). */
export function eraHBip(rates: NonNullable<Era["rates"]>): number {
  return ((rates.h - rates.hr) / rates.bip) / REF_NHH_PER_BIP;
}

// Reference XBH share of non-HR hits = era-2010's (b2+b3)/(h−hr). Guarded by a test.
const REF_XBH_SHARE_NHH = (0.04584 + 0.00471) / (0.22944 - 0.02488);

/** Per-non-HR-hit XBH SHARE era factor from an era's raw rates block: how an era moves the
 *  extra-base COMPOSITION of hits, not the XBH rate per PA. woba.ts applies era_gap onto
 *  GAP_rate × BA_fin, where BA_fin already carries the hit level (era_h) and the BIP
 *  expansion; the per-PA `gap` factor re-applies both (Job 2.1, same class as eraHBip). The
 *  share ratio isolates only the composition move (era-1920 0.855 vs per-PA 0.987; era-2019
 *  1.070 — sign flips: modern XBH was UNDER-predicted). */
export function eraGapShare(rates: NonNullable<Era["rates"]>): number {
  return ((rates.b2 + rates.b3) / (rates.h - rates.hr)) / REF_XBH_SHARE_NHH;
}

// Reference non-BIP-out fraction = era-2010's (1 − bb − k − hr − bip) = HBP+SH+SF+misc per PA.
// The BIP recompute subtracts a FIXED HIT_BIP_ADJ/PIT_BIP_ADJ (curves.ts) for these outs, but
// their real level varies by era (dead-ball 1920 ≈ 4.0% vs 2010 ≈ 1.68% — heavy sacrifice
// bunting), so a fixed constant over/understates BIP in extreme eras → the residual dead-ball
// hit/XBH over-prediction (BIP-recompute audit; plan §11.3). Guarded by a test.
const REF_NONBIP_2010 = 1 - (0.08512 + 0.18491 + 0.02488 + 0.68832);

/** Per-era scale for the fixed BIP_ADJ constant: how the era's non-BIP-out (HBP+SH+SF) level
 *  compares to 2010. `BIP_ADJ_era = BIP_ADJ × eraBipAdj(rates)`, so 2010 → 1 (the fitted
 *  convention is preserved), dead-ball 1920 → ~2.4 (more non-BIP outs → smaller BIP → fewer
 *  hits), modern high-K 2019 → ~0.9. Same class as era_h_bip / era_gap_share. */
export function eraBipAdj(rates: NonNullable<Era["rates"]>): number {
  return (1 - (rates.bb + rates.k + rates.hr + rates.bip)) / REF_NONBIP_2010;
}
const parkFactors = (p: Park): ParkFactors => ({
  avg_l: p.avg_l, avg_r: p.avg_r, hr_l: p.hr_l, hr_r: p.hr_r, gap: p.gap,
});

/** Assemble the scoring `Coeffs` bag from a tournament's resolved parts. */
export function resolveCoeffs(model: Model, era: Era, park: Park, softcaps: Softcaps): Coeffs {
  const bag = assembleCoeffs({
    era: eraFactors(era),
    park: parkFactors(park),
    softcaps,
    model: model.coeffs,
    extras: model.extras,
  });
  // Attached post-assembly (not part of the lossless split/assemble partition — captures
  // predate it and keep the legacy per-PA era_h derivation). Library eras all carry rates.
  // A PRESENT-but-partial block is rejected (would divide-by-zero into Infinity scores); an
  // ABSENT block is the legitimate legacy path (captures/synthetic → per-PA fallback).
  if (era.rates) {
    validateRates(era.rates, `resolveCoeffs(era ${era.id ?? "?"})`);
    bag.era_h_bip = eraHBip(era.rates); bag.era_gap_share = eraGapShare(era.rates); bag.era_bip_adj = eraBipAdj(era.rates);
  }
  // Baserunning value (UBR), league-fit + era-scaled by run scarcity. runVal absent (capture/synthetic
  // eras) ⇒ neutral 1. Overrides the model's extras adv_speed/adv_run (historically 0). adv_steal
  // untouched (0) — steal deferred. Only the hitter wOBA (woba.ts) reads these.
  const runVal = era.runVal ?? 1;
  bag.adv_speed = ADV_SPEED_UBR * runVal;
  bag.adv_run = ADV_RUN_UBR * runVal;
  return bag;
}

// ── Extractors: decompose a captured/flat bag into library + model entries ─────
// Used by seeding (bootstrap the file-based DB from captures) and by parity tests.

export function modelFromCoeffs(bag: Coeffs, id: string, name: string): Model {
  const p = splitCoeffs(bag);
  return { id, name, coeffs: p.model, extras: p.extras };
}

export function eraFromCoeffs(bag: Coeffs, id: string, name: string): Era {
  const e = splitCoeffs(bag).era;
  return { id, name, bb: e.bb, k: e.k, avg: e.avg, hr: e.hr, bip: e.bip, gap: e.gap, thr_toggle: e.thr_toggle, thr: e.thr };
}

export function parkFromCoeffs(bag: Coeffs, id: string, name: string): Park {
  const p = splitCoeffs(bag).park;
  return { id, name, avg_l: p.avg_l, avg_r: p.avg_r, hr_l: p.hr_l, hr_r: p.hr_r, gap: p.gap };
}

export function softcapsFromCoeffs(bag: Coeffs): Softcaps {
  return splitCoeffs(bag).softcaps;
}
