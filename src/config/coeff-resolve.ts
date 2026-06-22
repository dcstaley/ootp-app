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
const parkFactors = (p: Park): ParkFactors => ({
  avg_l: p.avg_l, avg_r: p.avg_r, hr_l: p.hr_l, hr_r: p.hr_r, gap: p.gap,
});

/** Assemble the scoring `Coeffs` bag from a tournament's resolved parts. */
export function resolveCoeffs(model: Model, era: Era, park: Park, softcaps: Softcaps): Coeffs {
  return assembleCoeffs({
    era: eraFactors(era),
    park: parkFactors(park),
    softcaps,
    model: model.coeffs,
    extras: model.extras,
  });
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
