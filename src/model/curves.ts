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
export interface FittedEvent { beta: number[]; mu: number; sd: number; curve: Curve; aux?: { beta: number; mu: number; sd: number } }

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
/** Fitted per-event rate at a rating value, clamped ≥ 0 (matches the chain). */
export const rate = (e: FittedEvent, v: number) => Math.max(dot(e.beta, row(e.curve, v, e.mu, e.sd)), 0);
/** Like `rate`, plus the optional Stuff (or other) aux term. `auxV` = the aux rating
 *  value; ignored when the event has no `aux`, so this is safe to call everywhere. */
export const rateAux = (e: FittedEvent, v: number, auxV: number) => {
  const base = dot(e.beta, row(e.curve, v, e.mu, e.sd));
  const a = e.aux ? e.aux.beta * (e.aux.sd > 1e-9 ? (ln1(auxV) - e.aux.mu) / e.aux.sd : 0) : 0;
  return Math.max(base + a, 0);
};

// The H (non-HR hit) event has TWO inputs, each with its OWN curve: the BABIP/PBABIP
// RATING and the derived BIP count. Design = [1, <rating basis>, <bip basis>] (shared
// intercept). Both default to log (parity); both configurable so neither is assumed.
export interface CurveFit { curve: Curve; mu: number; sd: number }
export interface FittedH { beta: number[]; rating: CurveFit; bip: CurveFit }
export const rowTerms = (c: Curve, v: number, mu: number, sd: number) => row(c, v, mu, sd).slice(1); // basis minus the shared intercept
export const hDesign = (r: CurveFit, rv: number, b: CurveFit, bv: number) => [1, ...rowTerms(r.curve, rv, r.mu, r.sd), ...rowTerms(b.curve, bv, b.mu, b.sd)];
export const hRate = (m: FittedH, rv: number, bv: number) => Math.max(dot(m.beta, hDesign(m.rating, rv, m.bip, bv)), 0);

// ── Fitted #2 (raw-poly) parameter sets — one per-event Curve fit each ──────────
// Produced by fitHitForm/fitPitForm (src/training/forms.ts) and consumed at predict
// time by the deployed raw-poly model + the woba.ts recompute. Carried in config as
// EventForm (ScoringConfig.eventForm); absent ⇒ the parity log-linear path is used.
export interface FittedHit { bb: FittedEvent; k: FittedEvent; hr: FittedEvent; h: FittedH; xbh: FittedEvent }
export interface FittedPit { bb: FittedEvent; k: FittedEvent; hr: FittedEvent; h: FittedH }
export interface EventForm { hit: FittedHit; pit: FittedPit }
