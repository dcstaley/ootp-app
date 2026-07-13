# OOTP Roster Optimizer (rebuild)

From-scratch rebuild. The governing principle: **one scoring core, computed once, consumed
identically by every consumer.** See `CLAUDE.md` (operating context) and `docs/` (discovery,
requirements/decisions D1–D7, architecture).

## Status

**Step 1 — scoring core: built, parity harness green on a synthetic smoke test.** Awaiting real
per-tournament captures from the old app to validate against the user's trusted scores.

## Layout

| Path | What |
|---|---|
| `src/scoring-core/` | The one scoring core (helpers, basic, wOBA+calibration, orchestrator) |
| `src/model/` | D3 swappable event model (`EventModel`); `raw-poly.ts` is the deployed form (`log-linear.ts` retired) |
| `src/config/` | Coeffs / CalScales / Derived types + `derived` values |
| `fixtures/captures/` | Captured `{coeffs, calScales}` per tournament — scoring-input fixtures for the test suite |

> Old-app **parity is sunset** (2026-07-01): the `tools/golden/` harness, `fixtures/golden/` snapshots,
> the `npm run golden` script, and the parity test were removed. The deployed model is the data-driven
> raw-poly event model; scoring changes no longer validate against the old app. See CLAUDE.md.

## Commands

```
npm test            # unit + integration tests
npm run typecheck   # tsc --noEmit
```
