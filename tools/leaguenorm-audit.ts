// THROWAWAY diagnostic — Phase-1 leagueNorm investigation (2026-06-29).
//
// Questions (user, "we need to be correct on what we're assuming"):
//  1. Is the (neutral-env) training data actually at the Section-3 baseline — i.e. the
//     ≈2010-MLB league totals OOTP normalizes a league toward?
//  2. Is the leagueNorm coefficient redundant under #2? #2 is fit to ACTUAL rates, so its
//     PA-weighted-mean prediction ≈ the data's actual mean (WLS property). Hence #2's
//     implied leagueNorm = Section-3 target ÷ training-data actual aggregate. If the data
//     sits at baseline that's ≈1 (redundant); if not, leagueNorm is doing real work.
//
// Measures the ACTUAL league-aggregate per-600 rates (Σevent / Σdenom × 600) over three
// pools — full league, qualifying (PA/BF≥1000), and the top-50 calibration anchor — plus
// #2's predicted aggregate, all vs the Section-3 targets and the OLD captured leagueNorms.

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { defaultWindow } from "../src/training/evaluate.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, RAWPOLY_PIT } from "../src/training/forms.ts";
import { rate, hRate } from "../src/model/curves.ts";

const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const WINDOW = ROOT === "League Files" ? defaultWindow(availableYears(ROOT)) : [2037, 2038];

// Section-3 league baseline targets (per 600), from the old app's leagueNorm machinery.
const S3_HIT: Record<string, number> = { BB: 48.43, K: 117.40, HR: 14.87, nHH: 124.75, XBH: 31.26 };
const S3_PIT: Record<string, number> = { BB: 47.80, HR: 14.96 }; // only BB/HR are codified pitch targets
// OLD captured model leagueNorm coefficients (real-neutral capture) — reference.
const OLD_HIT_LN: Record<string, number> = { BB: 0.989556, K: 1.001195, HR: 0.982529, nHH: 0.996074, XBH: 0.997353 };
const OLD_PIT_LN: Record<string, number> = { BB: 0.977922, HR: 0.988549 };

const { observations, summary } = loadWindow(ROOT, WINDOW);
const hitFull = observations.filter((o) => o.hit.PA > 0);
const pitFull = observations.filter((o) => o.pitch.BF > 0);
const hitQual = observations.filter((o) => o.hit.PA >= 1000);
const pitQual = observations.filter((o) => o.pitch.BF >= 1000);

const hitEv: Record<string, (o: TrainObs) => number> = {
  // nHH = NON-HR hits (H − HR): the model's "H" event and the S3 "H" target are both
  // non-HR (total hits = nHH + HR). Comparing model-nHH to data-TOTAL-H was apples/oranges.
  BB: (o) => o.hit.BB, K: (o) => o.hit.K, HR: (o) => o.hit.HR, nHH: (o) => o.hit.H - o.hit.HR, XBH: (o) => o.hit.b2 + o.hit.b3,
};
const pitEv: Record<string, (o: TrainObs) => number> = {
  BB: (o) => o.pitch.BB, K: (o) => o.pitch.K, HR: (o) => o.pitch.HR, H: (o) => o.pitch.b1 + o.pitch.b2 + o.pitch.b3,
};

// Aggregate per-600 rate over a pool: Σ event / Σ denom × 600 (the true league total rate).
const agg = (pool: TrainObs[], denom: (o: TrainObs) => number, ev: (o: TrainObs) => number) => {
  const D = pool.reduce((s, o) => s + denom(o), 0);
  return D > 0 ? (pool.reduce((s, o) => s + ev(o), 0) / D) * 600 : 0;
};
// Top-50-by-wOBA anchor (matches calibrate.ts): wOBA proxy from actual events.
const W = { BB: 0.704, B1: 0.8992, XBH: 1.29, HR: 2.0759 };
const hitWoba = (o: TrainObs) => (W.BB * o.hit.BB + W.B1 * (o.hit.H - o.hit.HR - o.hit.b2 - o.hit.b3) + W.XBH * (o.hit.b2 + o.hit.b3) + W.HR * o.hit.HR) / Math.max(o.hit.PA, 1);
const anchorHit = [...hitQual].sort((a, b) => hitWoba(b) - hitWoba(a)).slice(0, 50);
const pitAllowed = (o: TrainObs) => (W.BB * o.pitch.BB + W.B1 * o.pitch.b1 + W.XBH * (o.pitch.b2 + o.pitch.b3) + W.HR * o.pitch.HR) / Math.max(o.pitch.BF, 1);
const anchorPit = [...pitQual].sort((a, b) => pitAllowed(a) - pitAllowed(b)).slice(0, 50);

// #2 fit + per-event predicted per-600 (mirrors forms.ts predictHitForm/predictPitForm internals).
const hf = fitHitForm(RAWPOLY_HIT, hitQual), pf = fitPitForm(RAWPOLY_PIT, pitQual);
function hitPred(o: TrainObs): Record<string, number> {
  const r = o.ratings.hit;
  const bb = rate(hf.bb, r.eye), k = rate(hf.k, r.kRat), hr = rate(hf.hr, r.pow);
  const bip = Math.max(600 - bb - k - hr - 6 - 3 + 4, 1);
  const h = hRate(hf.h, r.babip, bip);
  return { BB: bb, K: k, HR: hr, nHH: h, XBH: Math.max(rate(hf.xbh, r.gap) * h, 0) };
}
function pitPred(o: TrainObs): Record<string, number> {
  const r = o.ratings.pitch;
  const bb = rate(pf.bb, r.con), k = rate(pf.k, r.stu), hr = rate(pf.hr, r.hrr);
  const bip = Math.max(600 - bb - k - hr - 6, 1);
  return { BB: bb, K: k, HR: hr, H: hRate(pf.h, r.pbabip, bip) };
}
// #2 predicted PA-weighted aggregate per-600 for an event.
const predAgg = (pool: TrainObs[], wt: (o: TrainObs) => number, pred: (o: TrainObs) => number) => {
  const Wt = pool.reduce((s, o) => s + wt(o), 0);
  return pool.reduce((s, o) => s + pred(o) * wt(o), 0) / Wt;
};

const f = (x: number, w = 7) => x.toFixed(2).padStart(w);
function report(role: string, S3: Record<string, number>, OLD: Record<string, number>, full: TrainObs[], qual: TrainObs[], anchor: TrainObs[], denom: (o: TrainObs) => number, ev: Record<string, (o: TrainObs) => number>, pred: (o: TrainObs) => Record<string, number>) {
  console.log(`\n=== ${role} (window ${WINDOW.join("+")}, ${ROOT}) — per-600 league-aggregate rates ===`);
  console.log(`pools: full=${full.length}  qualifying=${qual.length}  anchor=${anchor.length}`);
  console.log(`event |  S3 tgt | full agg |  qual agg | anchor-50 |  #2 pred | impliedLN(S3/qual) | oldLN`);
  for (const k of Object.keys(ev)) {
    const tgt = S3[k];
    const fa = agg(full, denom, ev[k]!), qa = agg(qual, denom, ev[k]!), an = agg(anchor, denom, ev[k]!);
    const p2 = predAgg(qual, denom, (o) => pred(o)[k]!);
    const ln = tgt != null && qa > 0 ? tgt / qa : NaN;
    console.log(`${k.padEnd(5)} | ${tgt != null ? f(tgt) : "    —  "} | ${f(fa)} | ${f(qa)} | ${f(an)} | ${f(p2)} | ${Number.isFinite(ln) ? f(ln, 18) : "        —         "} | ${OLD[k] != null ? OLD[k]!.toFixed(4) : "  —  "}`);
  }
}

console.log(`leagueNorm audit — ${summary.leagues.length} leagues, years ${summary.years.join(",")}`);
report("HITTING", S3_HIT, OLD_HIT_LN, hitFull, hitQual, anchorHit, (o) => o.hit.PA, hitEv, hitPred);
report("PITCHING", S3_PIT, OLD_PIT_LN, pitFull, pitQual, anchorPit, (o) => o.pitch.BF, pitEv, pitPred);
console.log(`\nReading: impliedLN(S3/qual) ≈ 1 ⇒ #2 already sits at the Section-3 baseline (leagueNorm redundant).`);
console.log(`Far from 1 ⇒ the data is OFF baseline and leagueNorm (or era) is doing real level work.`);
console.log(`#2 pred vs qual agg shows the WLS property (#2 sits at the data's actual mean).`);
