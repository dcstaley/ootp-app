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

/** Per-BIP non-HR-hit era factor from an era's raw rates block: how an era moves hits PER
 *  BALL IN PLAY, not per PA. The per-PA `avg` double-counts the era's K/BB-driven BIP
 *  expansion when applied to the recompute's per-BIP hit chain (the dead-ball 1B
 *  over-prediction — plan doc §10: era-1920 configured era_h 1.152 vs 0.974 per-BIP,
 *  implied-by-actuals ≈1.0; sign flips for modern high-K eras). */
export function eraHBip(rates: NonNullable<Era["rates"]>): number {
  return ((rates.h - rates.hr) / rates.bip) / REF_NHH_PER_BIP;
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
  if (era.rates) bag.era_h_bip = eraHBip(era.rates);
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
