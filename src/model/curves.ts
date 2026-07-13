// Shared curve-eval primitives for the D3 event forms. ONE home for the per-event
// basis math (#2 raw-poly's quadratic + the log baseline), imported by the bake-off
// forms (src/training/forms.ts), the deployed raw-poly model (src/model/raw-poly.ts),
// and the scoring-core recompute (src/scoring-core/woba.ts). Pure EVALUATION only —
// fitting (which needs `wls`, training-only) stays in forms.ts.
//
// Parity-critical invariant: the `log` curve evaluates to EXACTLY [1, ln(max(r,1))]
// (NOT z-scored), so an all-log form stays bit-identical to the parity assembly.

export const ln1 = (x: number) => Math.log(Math.max(x, 1));
export const dot = (b: number[], x: number[]) => b.reduce((s, bi, j) => s + bi * x[j]!, 0);

// ── BIP convention constants (the ONE copy) ────────────────────────────────────
// BIP = 600 − BB − K − HR − <adj>. Training (forms.ts), the deployed model
// (raw-poly.ts), and the scoring-core recompute (woba.ts, eventForm path) must all
// derive BIP with the SAME constant or the fitted H-curve is evaluated off its fit
// convention. Hitting: HBP 6 + SH 3 − SF 4; pitching: HBP 6 (no SH/SF).
export const HIT_BIP_ADJ = 6 + 3 - 4;
export const PIT_BIP_ADJ = 6;

// ── Curve = the per-event basis choice ─────────────────────────────────────────
export type Curve =
  | { kind: "log" }                          // [1, ln(max(r,1))] — parity baseline, NOT z-scored
  | { kind: "rawpoly"; degree: 1 | 2 | 3 }   // [1, u, u², …] with u = z(r)        — raw curvature
  | { kind: "logpoly"; degree: 2 | 3 };      // [1, u, u², …] with u = z(ln r)      — higher-order log
export const LOG: Curve = { kind: "log" };

// `aux` = an OPTIONAL secondary z-scored ln(rating) LINEAR term on top of the primary
// curve. Pitching BB and HR carry a Stuff aux (high Stuff suppresses walks/homers beyond
// Control/HRR — a real channel measured in the outcomes). Absent ⇒ `rateAux` ≡ `rate`,
// so every existing form stays bit-identical.
// `uMin`/`uMax` = the z-score domain the curve was FIT over (poly curves only), stored so
// the direction-aware monotone cap can tell whether a quadratic's vertex is INTERIOR to the
// domain (a real turn-over to clamp) vs outside it (already monotone → leave alone). Absent on
// legacy artifacts ⇒ the cap falls back to its old increasing-only behavior (so already-deployed
// scores are byte-for-byte unchanged; a retrain stamps the domain and enables the new cap).
export interface FittedEvent { beta: number[]; mu: number; sd: number; curve: Curve; aux?: { beta: number; mu: number; sd: number }; uMin?: number; uMax?: number }

// The pre-z-score base value for a polynomial curve: ln(rating) for logpoly, the
// raw rating for rawpoly. (log is handled separately — kept exactly [1, ln r] so it
// stays bit-identical to the parity assembly.)
export const baseVal = (curve: Curve, v: number) => (curve.kind === "logpoly" ? ln1(v) : v);

/** Design row for one rating value under a curve (uses stored μ/σ for poly curves). */
export function row(curve: Curve, v: number, mu: number, sd: number): number[] {
  if (curve.kind === "log") return [1, ln1(v)];
  const u = sd > 1e-9 ? (baseVal(curve, v) - mu) / sd : 0;
  const out = [1];
  for (let d = 1; d <= curve.degree; d++) out.push(u ** d);
  return out;
}
// Monotone guard (T-5): an over-fit degree-2 rawpoly turns over — past its vertex a BETTER
// rating predicts a WORSE rate. The cap is DIRECTION-AWARE: it infers the event's intended
// direction from the sign of the curve across its fit domain, then clamps ONLY the wrong-way
// tail beyond an INTERIOR vertex — so an increasing event stays flat past a peak AND a
// decreasing event stays flat past a valley, and neither is ever wholesale-flattened (the
// vertex is strictly interior, so the correct-direction tail is always preserved). When the
// fit domain (uMin/uMax) is absent (legacy artifact) it falls back to the old increasing-only
// clamp so deployed scores are unchanged. EVALUATION-only; the fit itself is untouched.
function monoZ(beta: number[], curve: Curve, u: number, uMin?: number, uMax?: number): number {
  if (curve.kind !== "rawpoly" || curve.degree !== 2) return u;
  const b1 = beta[1] ?? 0, b2 = beta[2] ?? 0;
  if (Math.abs(b2) < 1e-12) return u;              // ~linear → monotone, nothing to cap
  const vertex = -b1 / (2 * b2);
  if (uMin != null && uMax != null) {
    if (vertex <= uMin || vertex >= uMax) return u; // vertex outside domain ⇒ monotone over it
    // Intended direction = sign of f(uMax) − f(uMin) (b0 cancels); clamp the wrong-way tail.
    const dirUp = (b1 * (uMax - uMin) + b2 * (uMax * uMax - uMin * uMin)) > 0;
    // ∩ (b2<0) rises→falls; ∪ (b2>0) falls→rises. The tail that violates the intended direction:
    const clampAbove = (dirUp && b2 < 0) || (!dirUp && b2 > 0); // clamp u>vertex, else u<vertex
    return clampAbove ? (u > vertex ? vertex : u) : (u < vertex ? vertex : u);
  }
  // Legacy fallback (no fit domain stored): the original increasing-only ∩ clamp.
  if (b2 < 0 && u > vertex) return vertex;
  return u;
}
/** Design row with the monotone guard applied (needs beta + fit-domain to locate the vertex). */
function rowMono(beta: number[], curve: Curve, v: number, mu: number, sd: number, uMin?: number, uMax?: number): number[] {
  if (curve.kind === "log") return [1, ln1(v)];
  const u = monoZ(beta, curve, sd > 1e-9 ? (baseVal(curve, v) - mu) / sd : 0, uMin, uMax);
  const out = [1];
  for (let d = 1; d <= curve.degree; d++) out.push(u ** d);
  return out;
}
/** Fitted per-event rate at a rating value, clamped ≥ 0 (matches the chain), monotone-guarded. */
export const rate = (e: FittedEvent, v: number) => Math.max(dot(e.beta, rowMono(e.beta, e.curve, v, e.mu, e.sd, e.uMin, e.uMax)), 0);
/** UNCAPPED fitted rate — the raw curve before the monotone guard. The gate samples THIS so an
 *  over-fit turn-over stays visible (the cap must not hide corruption from bake-off comparison). */
export const rateRaw = (e: FittedEvent, v: number) => Math.max(dot(e.beta, row(e.curve, v, e.mu, e.sd)), 0);
/** True iff the monotone cap actually changes the curve anywhere in [lo, hi] (poly rawpoly-2 only). */
export const capActive = (e: FittedEvent, lo: number, hi: number): boolean => {
  if (e.curve.kind !== "rawpoly" || e.curve.degree !== 2) return false;
  for (let i = 0; i <= 40; i++) { const v = lo + ((hi - lo) * i) / 40; if (Math.abs(rate(e, v) - rateRaw(e, v)) > 1e-9) return true; }
  return false;
};
/** Like `rate`, plus the optional Stuff (or other) aux term. `auxV` = the aux rating
 *  value; ignored when the event has no `aux`, so this is safe to call everywhere. */
export const rateAux = (e: FittedEvent, v: number, auxV: number) => {
  const base = dot(e.beta, rowMono(e.beta, e.curve, v, e.mu, e.sd, e.uMin, e.uMax));
  const a = e.aux ? e.aux.beta * (e.aux.sd > 1e-9 ? (ln1(auxV) - e.aux.mu) / e.aux.sd : 0) : 0;
  return Math.max(base + a, 0);
};

// The H (non-HR hit) event has TWO inputs: the BABIP/PBABIP RATING and the derived
// BIP count. TWO shapes exist:
//   • fitted log-BIP (the DEPLOYED shape — RAWPOLY_HIT/PIT omit `hBip` ⇒ default LOG, so
//     the BIP count enters the design as its OWN fitted curve — beta over [1, <rating
//     basis>, <bip basis>]). This is what production scores with. The fitted BIP elasticity
//     is genuinely identified (≈0.86 hit / 0.92 pit).
//   • perBip (unit BIP elasticity): H = perBIP_rate(rating) × BIP — the BIP relation PINNED
//     to proportionality. `beta` spans the RATING design only: [1, <rating basis>]. This is
//     the physically-motivated alternative, kept ONLY as the `woba·perbip` bake-off
//     candidate and NOT adopted (pinning elasticity to 1.0 made the dead-ball 1B bias WORSE).
//     Reached only when a form sets hBip:"unit" (PERBIP_*) or an artifact stored perBip:true.
// AUDIT NOTE (2026-07-13, finding C): earlier comments here mislabeled perBip as "CURRENT" and
// fitted log-BIP as "legacy ≤ v2" — BACKWARDS. Deployed = fitted log-BIP; trust the artifact.
// This is the ONE definition of the H↔BIP relation — training (forms.ts), the deployed
// model (raw-poly.ts), and the scoring-core recompute (woba.ts) all evaluate via hRate.
export interface CurveFit { curve: Curve; mu: number; sd: number }
export interface FittedH {
  beta: number[];
  rating: CurveFit;
  bip?: CurveFit;   // legacy shape only (fitted BIP curve); absent under perBip
  perBip?: boolean; // true ⇒ unit-elasticity shape (beta is the per-BIP rate curve). The DEPLOYED model leaves this absent (fitted log-BIP); only PERBIP_* / perBip-stored artifacts set it.
}
export const rowTerms = (c: Curve, v: number, mu: number, sd: number) => row(c, v, mu, sd).slice(1); // basis minus the shared intercept
export const hDesign = (r: CurveFit, rv: number, b: CurveFit, bv: number) => [1, ...rowTerms(r.curve, rv, r.mu, r.sd), ...rowTerms(b.curve, bv, b.mu, b.sd)];
export const hRate = (m: FittedH, rv: number, bv: number) =>
  m.perBip
    ? Math.max(dot(m.beta, [1, ...rowTerms(m.rating.curve, rv, m.rating.mu, m.rating.sd)]), 0) * bv
    : Math.max(dot(m.beta, hDesign(m.rating, rv, m.bip!, bv)), 0);

// ── Fitted #2 (raw-poly) parameter sets — one per-event Curve fit each ──────────
// Produced by fitHitForm/fitPitForm (src/training/forms.ts) and consumed at predict
// time by the deployed raw-poly model + the woba.ts recompute. Carried in config as
// EventForm (ScoringConfig.eventForm); absent ⇒ the parity log-linear path is used.
export interface FittedHit { bb: FittedEvent; k: FittedEvent; hr: FittedEvent; h: FittedH; xbh: FittedEvent }
export interface FittedPit { bb: FittedEvent; k: FittedEvent; hr: FittedEvent; h: FittedH }
export interface EventForm { hit: FittedHit; pit: FittedPit }
