# BUILD-2 state — hitter HR+BABIP(+SO) paired tail correction

**STATUS: COMPLETE (2026-07-17).** Full report: `docs/CWHIT_HITTAIL_BUILD2_2026-07-17.md`.
This file remains only as the interruption-insurance pointer.

- Bake-off tool: `tools/hit-tail-bakeoff.ts` (imports the production correction math — one copy).
- Run snapshots: `fixtures/hit-tail-bakeoff-run-2026-07-16.txt` (oaxaca catalog) and
  `fixtures/hit-tail-bakeoff-run-2026-07-17-pinned.txt` (cdmx, final, pinned config in lineup).
- Verdict: **B (league-refit form change) DEAD** — league-fit forms cannot express an out-of-frame
  defect (in-domain predictions identical; the M6 rejection replicates with slope first-class).
  **A (gap-conditioned event-space, THREE legs) WINS**: `PINNED_HIT_TAIL` = HR hinge-lin λ2.20 +
  BABIP hinge-sat λ1.10 + SO step-sat λ0.30 — **7/7 pre-registered gates**, held-out-tier pass,
  league identity exact, weird-env directional pass, composite ordering IMPROVES CI-clear (+0.048).
  Elite-power cancellation RESOLVED (drivers each ≈0), contact fixed, whiff-slugger fixed.
- Implementation: `src/scoring-core/hit-tail.ts` + kSpread-seam application in score-card.ts /
  calibrate.ts, threaded via `ScoringConfig.hitTail`, gated on `Tournament.hitTailCorrection`
  (DORMANT — no default flip; Derek activates). Tests: `tests/hit-tail.test.ts` (14 invariants).
  Landed at 02f3811.
- Open residuals (§4 of the report): Q2/Q3 mid-POW hump (untouched, bounded), BABIP/SO level
  footprints (the format-constant program must measure on top of this), era-2010-daily BABIP slope
  overshoot flag, blended-vs-per-side second-order note.
- Concurrency note: the server.ts hook (flag-gated `computeHitTail` call in the own-gap branch)
  exists in the working tree but was kept out of the module commit while BUILD-1's K-spread server
  wiring (their unit 2/2) was in flight in the same file; it lands once server.ts is committable
  without capturing their half-done work. Backup of the mixed diff noted in session scratchpad.
