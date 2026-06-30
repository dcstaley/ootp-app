// The ONE source of truth for the wOBA event weights (D1: wOBA = event pipeline).
// These were previously copy-pasted across woba.ts, bakeoff.ts, forms.ts, and fit.ts —
// a "one scoring core" violation. They live here now; every assembler reads from here.
//
// DEFAULT_WOBA_WEIGHTS reproduces the historical hard-coded constants EXACTLY (the
// parity baseline). A trained model may carry its OWN weights, reverse-engineered from
// the game's wRAA over that model's leagues (see src/training/woba-weights.ts); when a
// weights-bearing model is active those override the defaults at scoring time (folded
// into the coeff bag as w_bb/w_hbp/w_1b/w_xbh/w_hr, read back via `wobaWeightsFromCoeffs`).
//
// `xbh` is a SINGLE extra-base weight because the event model predicts one combined XBH
// rate (no 2B/3B split) — the derived value is the frequency-weighted blend of the game's
// separate 2B and 3B weights.

import type { Coeffs } from "../config/types.ts";

export interface WobaWeights { bb: number; hbp: number; b1: number; xbh: number; hr: number }

export const DEFAULT_WOBA_WEIGHTS: WobaWeights = { bb: 0.704, hbp: 0.704, b1: 0.8992, xbh: 1.29, hr: 2.0759 };

/** Read per-event weights from the coeff bag (flat w_* keys), defaulting to the
 *  historical constants — so a config without them scores bit-identically. */
export function wobaWeightsFromCoeffs(c: Coeffs): WobaWeights {
  const n = (k: string, d: number): number => { const v = c[k]; return typeof v === "number" ? v : d; };
  return {
    bb: n("w_bb", DEFAULT_WOBA_WEIGHTS.bb), hbp: n("w_hbp", DEFAULT_WOBA_WEIGHTS.hbp),
    b1: n("w_1b", DEFAULT_WOBA_WEIGHTS.b1), xbh: n("w_xbh", DEFAULT_WOBA_WEIGHTS.xbh),
    hr: n("w_hr", DEFAULT_WOBA_WEIGHTS.hr),
  };
}

/** Fold a model's weights into a coeff bag (the inverse of the reader). */
export function applyWobaWeights(c: Coeffs, w: WobaWeights): void {
  c.w_bb = w.bb; c.w_hbp = w.hbp; c.w_1b = w.b1; c.w_xbh = w.xbh; c.w_hr = w.hr;
}
