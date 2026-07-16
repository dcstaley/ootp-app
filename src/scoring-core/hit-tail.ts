// GAP-CONDITIONED HITTER TAIL CORRECTION (BUILD-2) — the ONE copy of the correction math.
//
// WHAT: three per-channel event-space corrections on the hitter line (HR per-600, SO per-600, and
// BABIP), applied to the RAW model events immediately after `predictHitting` — the same seam as the
// frame-v2 K-spread (`applyKSpread`): pre-era, pre-BIP-chain, so era factors apply once and the BIP
// recompute stays consistent downstream.
//
// WHY (evidence: tools/hit-tail-bakeoff.ts + fixtures/hit-tail-bakeoff-run-2026-07-16.txt; program
// governance plan §15): out-of-frame (tournament pools), the hitter HR quad bends down too early —
// elite-power HR is under-predicted while mid-power is over-predicted (POW-quartile bias
// non-monotone, elite calibration slope 2.44 vs pooled 1.17); BABIP is tail-under-reacted (pooled
// 1.39, elite band 1.94); SO% under-reacts in its MID band (1.16, inverse-tail). League IN-FRAME is
// calibrated (insample-frame-check), so the correction must be exactly the identity at zero pool
// gap — which it is BY CONSTRUCTION: every strength is λ·w(g) with g = k−1 taken from the SAME
// own-gap pool-transform mean-scalar the rating lift uses (league/unrestricted pool ⇒ k ≤ 1 ⇒
// g = 0 ⇒ no-op). Parameters derive from pool composition + fitted universal constants only —
// properties-not-identity legal; never per-tournament.
//
// FAMILIES (all monotone — ordering within a pool can never flip):
//   hinge / hinge50: x + lw·max(x − pool_p75 | p50, 0)   one-sided tail stretch (lw > −1)
//   pivot:           pool_m + (1+lw)(x − pool_m)          level-preserving linear stretch (kSpread class)
//   quad:            x + lw·s·(z²−1)                      convexity restore; lw clamped by the pool's
//                                                         LEFT z-edge (only side where 1+2·lw·z < 0)
//   step:            x + lw·s·tanh(z)                     mid-band stretch, flat at both ends — the
//                                                         inverse-tail instrument (derivative ≥ 1 for lw ≥ 0)
// The bake-off's fit selected hinge (HR), hinge (BABIP) and step (SO); the full family set stays
// here as the one evaluation copy — the bake-off tool imports THESE functions.
//
// ACTIVATION: dormant by default. Wired behind `Tournament.hitTailCorrection` (no default flip —
// Derek activates per tournament config). With the flag off, no code path changes any score.

import { HIT_BIP_ADJ } from "../model/curves.ts";
import { applyAffine, type PoolTransform } from "../model/pool-transform.ts";
import type { EventModel } from "../model/types.ts";
import type { Coeffs } from "../config/types.ts";
import type { FieldStats } from "./pool-stats.ts";
import { n } from "./helpers.ts";

export type HitTailFamily = "hinge" | "hinge50" | "quad" | "pivot" | "step";
export type HitTailShape = "lin" | "sat";

/** Pool moments of one PREDICTED channel (own-gap-transformed, exposure-blended, VLvl-0 pool). */
export interface HitTailChanStat { m: number; s: number; p50: number; p75: number; zLo: number }

/** One channel's ready-to-apply correction: family + effective strength lw = λ·w(g) + pool stats. */
export interface HitTailChannel { fam: HitTailFamily; lw: number; st: HitTailChanStat }

/** The full correction state threaded through ScoringConfig (built once per tournament). */
export interface HitTail { hr: HitTailChannel; bab: HitTailChannel; so: HitTailChannel }

/** The FITTED, universal per-channel constants (λ + family + gap-conditioning shape). */
export interface HitTailChanCfg { fam: HitTailFamily; shape: HitTailShape; lam: number }
export interface HitTailCfg { hr: HitTailChanCfg; bab: HitTailChanCfg; so: HitTailChanCfg }

/** Saturating gap-shape scale: w_sat = 1 − e^(−g/G0) (≈ tier-flat by bronze-level gaps). */
export const HIT_TAIL_SAT_G0 = 0.10;
/** Gap conditioning w(g): "lin" = g itself, "sat" = saturating. w(0) = 0 ⇒ identity in-frame. */
export const hitTailW = (g: number, shape: HitTailShape): number =>
  shape === "lin" ? Math.max(g, 0) : 1 - Math.exp(-Math.max(g, 0) / HIT_TAIL_SAT_G0);

/**
 * THE PINNED OPERATING POINT (bake-off 2026-07-16; fit once on the five cwhit Quick tiers,
 * held-out-tier validated, gate-clean on both catalog snapshots (oaxaca λHR band 2.0–2.35,
 * cdmx 1.6–2.3 ⇒ pinned 2.20); weird-env directional pass on the three confirmed dailies).
 *   HR:    hinge above pool p75, gap-linear, λ = 2.20  (elite tail restored, mid hump untouched)
 *   BABIP: hinge above pool p75, saturating, λ = 1.10  (tail spacing 1.39 → ~1.0)
 *   SO:    step (tanh mid-band), saturating, λ = 0.30  (whiff tail re-credited; calibrated ends kept)
 */
export const PINNED_HIT_TAIL: HitTailCfg = {
  hr: { fam: "hinge", shape: "lin", lam: 2.2 },
  bab: { fam: "hinge", shape: "sat", lam: 1.1 },
  so: { fam: "step", shape: "sat", lam: 0.3 },
};

/**
 * Apply one correction family to a predicted channel value. `lw` = λ·w(g), the tier/pool-effective
 * strength. lw ≤ 0 ⇒ identity (the league frame). Pure; the ONE copy (bake-off imports this).
 */
export function correctChannel(x: number, st: HitTailChanStat, lw: number, fam: HitTailFamily): number {
  if (!(lw > 0)) return x;
  if (fam === "hinge") return x + lw * Math.max(x - st.p75, 0);
  if (fam === "hinge50") return x + lw * Math.max(x - st.p50, 0);
  if (fam === "pivot") return st.m + (1 + lw) * (x - st.m);
  const z = (x - st.m) / st.s;
  if (fam === "step") return x + lw * st.s * Math.tanh(z);
  const lwEff = Math.min(lw, 0.45 / Math.max(-st.zLo, 1e-9)); // quad: monotone-clamped by the left z-edge
  return x + lwEff * st.s * (z * z - 1);
}

/**
 * Apply the correction to one side's raw hitting events, IN PLACE (the kSpread convention).
 * Order matters and mirrors the bake-off's assembly exactly:
 *   1. SO′ and HR′ from their own channels;
 *   2. BABIP measured on the ORIGINAL BIP, corrected, then re-applied on the NEW BIP
 *      (600 − BB − SO′ − HR′ − HIT_BIP_ADJ) — so more strikeouts/homers consistently cost hits;
 *   3. oneB/GAP scaled proportionally (the hit MIX — the XBH share — is untouched).
 * Pre-era by construction: era factors and the trusted assembly run after this, once.
 */
export function applyHitTail(e: { BB: number; SO: number; HR: number; oneB: number; GAP: number }, ht: HitTail): void {
  const so2 = Math.max(correctChannel(e.SO, ht.so.st, ht.so.lw, ht.so.fam), 0);
  const hr2 = Math.max(correctChannel(e.HR, ht.hr.st, ht.hr.lw, ht.hr.fam), 0);
  const bip0 = Math.max(600 - e.BB - e.SO - e.HR - HIT_BIP_ADJ, 1);
  const h0 = e.oneB + e.GAP;
  const bab0 = h0 / bip0;
  const bab2 = Math.min(Math.max(correctChannel(bab0, ht.bab.st, ht.bab.lw, ht.bab.fam), 0), 0.6);
  const bip2 = Math.max(600 - e.BB - so2 - hr2 - HIT_BIP_ADJ, 1);
  const scale = h0 > 1e-9 ? (bab2 * bip2) / h0 : 1;
  e.SO = so2;
  e.HR = hr2;
  e.oneB *= scale;
  e.GAP *= scale;
}

// ── per-tournament state builder (the server calls this once, flag-gated) ────────────────────────

const chanStat = (xs: number[]): HitTailChanStat => {
  const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1;
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? m;
  return { m, s, p50: at(0.5), p75: at(0.75), zLo: sorted.length ? (sorted[0]! - m) / s : 0 };
};

/**
 * Build the per-tournament HitTail state from pool composition + the pinned constants.
 *   · Gaps g = max(ref.μ/pool.μ − 1, 0) per driving rating (POW / BABIP / AvoidK), from the SAME
 *     side-unified field stats the own-gap transform is built from — league pool ⇒ g = 0 ⇒ every
 *     lw = 0 ⇒ applyHitTail is the exact identity.
 *   · Channel moments = the VLvl-0 HITTER pool's predicted per-600 HR/SO and BABIP under the
 *     own-gap transform, exposure-blended with the SAME hit splits scoring uses (coeffs.*_hit_split)
 *     — mirroring the bake-off's pool distributions (its λs were fit against these moments).
 * Composes the ONE scoring core (predictHitting + applyAffine); no scoring math is defined here.
 */
export function computeHitTail(
  hitPool: any[], coeffs: Coeffs, model: EventModel, pt: PoolTransform,
  ref: FieldStats, poolField: FieldStats, cfg: HitTailCfg = PINNED_HIT_TAIL,
): HitTail {
  const gOf = (k: "pow" | "babip" | "kRat"): number => {
    const r = ref.hit.vR[k], p = poolField.hit.vR[k];
    return r && p && p.mu > 1e-9 ? Math.max(r.mu / p.mu - 1, 0) : 0;
  };
  const gPow = gOf("pow"), gBab = gOf("babip"), gK = gOf("kRat");
  const hrs: number[] = [], sos: number[] = [], babs: number[] = [];
  for (const c of hitPool) {
    const bats = n(c["Bats"]);
    const wR = bats === 1 ? coeffs.r_hit_split : bats === 2 ? 1 - coeffs.l_hit_split
      : (typeof coeffs.s_hit_split === "number" ? coeffs.s_hit_split : 0.5);
    const side = (s: "vR" | "vL") => {
      const t = pt.hit[s];
      return model.predictHitting({
        eye: applyAffine(n(c[`Eye ${s}`]), t?.eye), pow: applyAffine(n(c[`Power ${s}`]), t?.pow),
        kRat: applyAffine(n(c[`Avoid K ${s}`]), t?.kRat), babip: applyAffine(n(c[`BABIP ${s}`]), t?.babip),
        gap: applyAffine(n(c[`Gap ${s}`]), t?.gap),
        speed: n(c["Speed"]), steal: n(c["Stealing"]), run: n(c["Baserunning"]),
      }, coeffs);
    };
    const eR = side("vR"), eL = side("vL"), wL = 1 - wR;
    const BB = wR * eR.BB + wL * eL.BB, SO = wR * eR.SO + wL * eL.SO, HR = wR * eR.HR + wL * eL.HR;
    const H = wR * (eR.oneB + eR.GAP) + wL * (eL.oneB + eL.GAP);
    const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
    hrs.push(HR); sos.push(SO); babs.push(H / BIP);
  }
  return {
    hr: { fam: cfg.hr.fam, lw: cfg.hr.lam * hitTailW(gPow, cfg.hr.shape), st: chanStat(hrs) },
    bab: { fam: cfg.bab.fam, lw: cfg.bab.lam * hitTailW(gBab, cfg.bab.shape), st: chanStat(babs) },
    so: { fam: cfg.so.fam, lw: cfg.so.lam * hitTailW(gK, cfg.so.shape), st: chanStat(sos) },
  };
}
