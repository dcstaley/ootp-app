// ═══ EPHEMERAL SCOPE — "compute this, but do not let it become process state" ══
//
// THE BUG THIS CLOSES (item-B static audit, 2026-07-21). `/api/position-metrics` scores a POSSIBLY
// UNSAVED editor draft: the endpoint merges the request body over the stored record and calls
// `scoreTournament` on the result. That call reaches `referenceFieldStats` and
// `leagueExposureBaseline`, both of which are process-global caches keyed on
// `${activeModelId}|${catalogSource}` with NO tournament in the key.
//
// So on a COLD cache, the first thing to score wins — and an unsaved draft could be that thing.
// Every later tournament would then read a reference field seeded from a configuration THAT WAS
// NEVER SAVED, with nothing anywhere reporting it. The audit measured the exposure as small today
// (the pitcher leg is env-free EXACTLY; the hitter leg moves because baserunning coefficients are
// era-scaled — s_K up to ±0.023 at era-1920), but "small and silent and order-dependent" is the
// worst shape a defect can have: it cannot be reproduced from the saved state.
//
// THE FIX IS DELIBERATELY NARROW. It does not change what any cache CONTAINS or how it is computed —
// that would be a scoring change, and scoring changes ship only inside a constants event. It changes
// exactly one thing: whether a computation performed on behalf of an UNSAVED draft is allowed to
// PERSIST into process state. Reads are always allowed; only the write is suppressed.
//
// Why a counter rather than a boolean: nesting. `scoreTournament` may be called inside another
// ephemeral computation, and a boolean would be cleared by the inner scope's exit while the outer
// one was still running. The counter is exception-safe via `finally`, and the server is
// single-threaded so no cross-request interleaving can occur within one synchronous scope.

let depth = 0;

/** Run `fn` with cache WRITES suppressed. Reads are unaffected — a warm cache still serves. */
export function inEphemeralScope<T>(fn: () => T): T {
  depth++;
  try { return fn(); } finally { depth--; }
}

/** THE one decision point: may a computation store itself into a process-global cache?
 *  False only while an ephemeral scope is open. */
export const mayCache = (): boolean => depth === 0;

/** Test-only introspection, so a pin can prove the counter unwinds rather than assuming it. */
export const ephemeralDepth = (): number => depth;
