// D3 #2 (raw-poly) event model — the DEPLOYED default behind the EventModel seam.
// Quadratic on the power events (HR in POW/HRR, XBH-share in GAP), log everywhere
// else (BB, K, non-HR-hit, BIP) — the SAME structure both roles, fit per side. This
// is the production sibling of the bake-off's predictHitForm/predictPitForm
// (src/training/forms.ts); it shares the curve-eval primitives (curves.ts) so the
// assembled raw events here reproduce the bake-off model BIT-FOR-BIT.
//
// Two intentional departures from log-linear.ts:
//   • SOFTCAP-FREE — the quadratic replaces the log-linear softcap band-aid, so the
//     raw rating is passed straight through as babipSC/gapSC (the recompute reads it).
//   • the BIP chain uses the #2 TRAINING constants (6 HBP / 3 SH / 4 SF hitting,
//     6 HBP pitching — matching forms.ts), NOT coeffs, so a card scored under neutral
//     coeffs reproduces predictHitForm exactly. Era/park/calibration layer on later
//     in the woba.ts recompute, identically to the log path.
//
// The model is built per-config from the fitted EventForm (the EventModel seam only
// hands the model `ratings` + `coeffs`, so the curves are closed over here).

import type { Coeffs } from "../config/types.ts";
import { rate, rateAux, hRate, type EventForm } from "./curves.ts";
import type { EventModel, HittingRatings, PitchingRatings, RawHitting, RawPitching } from "./types.ts";

/** Build the deployed #2 event model bound to a fitted form (one per scoring config). */
export function makeRawPolyModel(form: EventForm): EventModel {
  const hit = form.hit, pit = form.pit;

  function predictHitting(r: HittingRatings, _c: Coeffs): RawHitting {
    const BB = rate(hit.bb, r.eye);
    const HR = rate(hit.hr, r.pow);          // quadratic in raw POW
    const SO = rate(hit.k, r.kRat);
    // BIP chain mirrors forms.ts predictHitForm exactly (6 HBP, 3 SH, 4 SF).
    const BIP = Math.max(600 - BB - SO - HR - 6 - 3 + 4, 1);
    const AB = Math.max(600 - BB - 4 - 3 - 6, 1); // for completeness (unused downstream)
    const H = hRate(hit.h, r.babip, BIP);    // non-HR hit rate (log H + log BIP term)
    const share = rate(hit.xbh, r.gap);      // quadratic XBH-share in raw GAP
    const GAP = Math.max(share * H, 0);
    const oneB = Math.max(H - GAP, 0);
    // Softcap-free: the raw ratings ARE the "softcapped" inputs the recompute reads.
    return { BB, SO, oneB, GAP, HR, AB, BIP, babipSC: r.babip, gapSC: r.gap };
  }

  function predictPitching(r: PitchingRatings, _c: Coeffs): RawPitching {
    const BB = rateAux(pit.bb, r.con, r.stu); // + linear Stuff term when the form carries it
    const K = rate(pit.k, r.stu);
    const HR = rateAux(pit.hr, r.hrr, r.stu); // + linear Stuff term (high Stuff suppresses HR)
    const BIP = Math.max(600 - BB - K - HR - 6, 1); // matches forms.ts predictPitForm
    const nHH = hRate(pit.h, r.pbabip, BIP);
    const XBH = nHH * 0.25;                   // fixed share (no GAP analog for pitchers)
    return { BB, K, HR, nHH, XBH, pbabipSC: r.pbabip };
  }

  return { predictHitting, predictPitching };
}
