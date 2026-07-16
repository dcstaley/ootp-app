# BUILD-2 state — hitter HR+BABIP paired tail correction (design + bake-off)

**Purpose of this file:** interruption insurance. If the session dies, resume from here in minutes.
Running record lives in memory `cwhit-program-batch-state`; governance in plan §15. This doc is the
BUILD-2-local state only.

## Status (2026-07-16)

- **Tool BUILT + RUN:** `tools/hit-tail-bakeoff.ts` (measurement/design only — no scoring change).
  Full run output snapshotted at `fixtures/hit-tail-bakeoff-run-2026-07-16.txt`.
- **BUILD-1 (pitcher K-spread) landed at 71464e1** — pitcher-side only; this work never touches it.
- Branch: `cwhit-scorecard-p1p2`.

## The design space tested

- **A. Gap-conditioned event-space corrections** on the predicted channel, after own-gap, per channel
  (HR600, BABIP, + optional SO% third leg). Families: `hinge` (stretch above pool p75), `hinge50`
  (above pool median), `quad` (convexity restore, monotone-clamped), `pivot` (pool-mean-preserving
  linear stretch = kSpread class), `step` (tanh mid-band stretch — the inverse-tail instrument).
  Strength = λ·w(g), g = k−1 from the own-gap pool transform's mean-scalar for the driving rating
  (POW/BABIP/AvoidK), w = g ("lin") or 1−e^(−g/0.10) ("sat"). **Identity at league (g=0) by
  construction** — no league refit, properties-legal (pool composition only). λ fit ONCE by grid on
  slope loss = 2·(pooled−1)² + (top−1)² + (rest−1)², all 5 Quick tiers; archetypes/ordering are
  acceptance-only, never fit targets.
- **B. Form change refit on league** (HR→linear/cubic, H→rawquad, combos), full-pipeline cwhit
  rebuild + league OOT both year-directions, slope first-class.

## Headline results (from the committed run snapshot)

- **B IS DEAD, with a structural explanation:** every B form is out-of-frame indistinguishable from
  the deployed quad (HR slope 1.17→1.17–1.21, elite top-band 2.44→1.80–2.48 all CI-wide; archetypes
  unchanged). League in-frame is already calibrated, own-gap-lifted tournament ratings stay
  IN-DOMAIN, so any form fitting league equally gives the same in-domain predictions — a league-fit
  form change CANNOT express an out-of-frame correction. The M6-era rejection replicates WITH the
  calibration slope first-class. League OOT year-splits show all candidates inside the year-noise
  envelope (HR slope 0.88–1.13 across directions even for the deployed form).
- **A WORKS and needs THREE legs.** HR+BABIP alone un-cancels elite power (+1.9* — the SO leg of the
  original cancellation, +1.2 mwOBA, left exposed; predicted by the archetype ledger). Adding the SO
  `step` leg (the work-order's "only if the design naturally fixes it" hook — step stretches the
  mid-band where SO% under-reacts 1.31–1.32× and leaves both calibrated ends alone):
- **WINNER: `A[hr:hinge-lin λ2.70 + bab:hinge-sat λ1.10 + so:step-lin λ1.05]` — 6/7 gates.**
  - HR600: pooled slope 1.17→**0.95 [0.92,0.99]** (the one marginal fail — see open item), elite
    top-band **2.44→1.05 [0.75,1.27]**, tail Δ +1.44*→+0.13 n.s. POW-grid Q4 bias −2.18*→+0.42 n.s.
    (iron −3.81*→+0.21).
  - BABIP: pooled **1.39→0.99 [0.92,1.06]**, top-band 1.94→0.98, tail Δ +0.66*→−0.11 n.s.
  - SO%: pooled 1.16→1.03 [1.00,1.05].
  - Ordering IMPROVES CI-clear: pooled wOBA corr 0.667→0.712, Δ +0.045 [+0.021,+0.070].
  - Archetypes: elite-power −0.14→+1.22 [−0.10,+2.56] (covers 0; drivers hr −0.1, bab +1.0, so +0.5);
    contact −1.84*→−0.83 n.s.; whiff-slugger −2.17→+0.05; walk-machine +0.59→+0.31.
  - Held-out-tier OOT: holds on every tier (held slopes 0.83–1.12 HR / 0.74–1.17 BAB / 0.93–1.11 SO);
    bronze mildly overshoots; diamond top-band cells are N=17 noise.
  - League identity: exact (g=0 at full catalog; verified numerically).
  - Weird-env (3 dailies, global λ): HR moves the right way everywhere (goldcap Q4 −7.01*→−5.37*,
    bronzeheart −1.33→−0.10, earlygold −1.56*→−1.24*; slopes 1.37→1.23 / 1.09→0.98 / 1.38→1.24);
    BABIP spacing improves (1.43→0.80, 1.65→1.17, 1.24→0.86 — earlygold/goldcap overshoot past 1)
    at the cost of a small +0.006–0.011 level footprint (interacts with the known format-level
    constants, a separate program).

## Open items (in order)

1. **HR λ sensitivity** — the single failing gate is HR pooled slope 0.95 [0.92,0.99]. The λ grid
   traded pooled-overshoot for top-band exactness. Probe λHR ∈ {2.0, 2.35, 2.70} with boot CIs on
   pooled + top: does a gate-clean operating point exist, or is it a real one-knob trade (sub-hinge
   region keeps its mild baseline over-dispersion)? Either way the choice of operating point is
   Derek's.
2. Decide wiring recommendation (config-gated, NO default flip — Derek activates). Sketch: one new
   module (e.g. `src/scoring-core/hit-tail.ts`) holding correctCh + the three ChCfg constants;
   applied in the deployed hitter path right after `predictHitting` under a tournament/model flag;
   strength from the SAME pool-transform k own-gap uses (identity when no poolTransform). MUST NOT
   touch pitcher paths (BUILD-1). Add tests: league identity, monotonicity, gate constants pinned.
3. Report to Derek: design comparison + recommendation (this doc + run snapshot are the evidence).

## Caveats to carry into any write-up

- λ fit and judgment share the 5-tier cwhit sample (held-out-tier is the honest OOT; no second
  external dataset exists at depth).
- The BABIP/SO corrections ADD level on the judged top-100 (hinge is one-sided): BABIP level bias
  +0.009→+0.016, SO +2.30→+2.08 (step helps). Uniform-within-role level is convention (Ruling 1),
  and the tournament frame-level constants are a SEPARATE quarantined program — but any future
  format-constant fit must be re-measured ON TOP of this correction if adopted.
- Diamond hit N=17, and hit diamond pit dead cell as always.
- Weird-env BABIP overshoot (slopes 0.80/0.86 at the two era-2010-ish dailies) — flag for Derek;
  possibly the daily g's (0.15–0.17) interact with era factors; directional data only.
