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
| `src/model/` | D3 swappable event model (`EventModel`); `log-linear.ts` is the current parity port |
| `src/config/` | Coeffs / CalScales / Derived types + `derived` values |
| `tools/golden/` | Throwaway validation harness — verbatim extract of the OLD app's scoring code |
| `tools/capture-snippet.js` | Paste into the old app's console to export a tournament's scoring env |
| `fixtures/captures/` | Captured `{coeffs, calScales}` per tournament (inputs to the golden) |
| `fixtures/golden/` | Generated reference scores the rebuilt core must reproduce |

## Validating parity against the old app

The benchmark of truth is the old **Roster & Lineup page's** calibrated scores (not the datagrid).

1. In the old app, open the Roster & Lineup page, select a tournament, click **Generate** once
   (this computes the calibration scales).
2. Open DevTools → Console, edit `LABEL` in `tools/capture-snippet.js`, paste it, run. A file
   downloads.
3. Drop the file in `fixtures/captures/`.
4. `npm run golden` then `npm test`.

Repeat per tournament / era / park setting you want covered.

## Commands

```
npm test            # parity tests
npm run golden      # regenerate golden refs from fixtures/captures
npm run typecheck   # tsc --noEmit
```
