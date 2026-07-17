# BUILD-2 — hitter HR+BABIP(+SO) paired tail correction: design bake-off, verdict, wiring

Tool: `tools/hit-tail-bakeoff.ts` (run: `node tools/hit-tail-bakeoff.ts`). Run snapshots:
`fixtures/hit-tail-bakeoff-run-2026-07-16.txt` (catalog oaxaca) and
`fixtures/hit-tail-bakeoff-run-2026-07-17-pinned.txt` (catalog cdmx, the FINAL run with the pinned
config in the lineup — Derek switched the active catalog mid-program, which doubles as a free
catalog-snapshot robustness check; every qualitative verdict replicates on both).

Companion governance: plan §15. Evidence base: MMSE battery (`docs/CWHIT_MMSE_BATTERY_2026-07-16.md`),
archetype ledger (`fixtures/cwhit-archetypes-run-2026-07-16.txt`), hr-reconcile quartile grid.
Sibling: BUILD-1 pitcher K-spread (`docs/CWHIT_KSPREAD_PIT_2026-07-16.md`) — pitcher-side; disjoint.

## 1. The problem (pre-registered)

Out-of-frame (tournament pools), three independent views agree:
- **HR600 non-monotone by POW quartile** (pooled Q1 −0.53*, Q2 +1.14*, Q3 +1.42*, Q4 −2.18*;
  iron Q4 −3.81*): over-predict MID power, under-predict ELITE power. Elite calibration slope 2.44
  vs pooled 1.17 — the hitter HR quad bends down too early where tournament pools land.
- **BABIP tail**: pooled slope 1.39 [1.24,1.56], elite band 1.94.
- **The cancellation constraint**: elite-power net mis-valuation ≈ 0 TODAY only because HR
  under-credit (−3.6 mwOBA) cancels BABIP (+2.6) + SO (+1.2) over-credits. Fixing pieces alone
  un-cancels. The archetype ledger re-run (with per-channel drivers) is the acceptance check.
- League IN-FRAME is calibrated ⇒ corrections must be identity at gap→0, parameters from pool
  composition/config only (properties-not-identity rule); linear scalar provably wrong for HR.

## 2. Candidates and verdicts

### B. League-refit form change — **DEAD, with a structural explanation**

HR→linear/cubic, H(BABIP)→rawquad, combos; full-pipeline cwhit rebuilds + league OOT (both
year-directions, calibration slope first-class — the retest the M6-era rejection never had).

| form | cwhit HR slope / top | cwhit BAB slope / top | elite-power | league OOT |
|---|---|---|---|---|
| deployed quad | 1.16 / 2.46 | 1.39 / 1.94 | −0.2 | HR slope 0.88↔1.13 by year |
| B-hrlin | 1.19 / 1.79 | 1.36 / 2.03 | −0.2 | within year-noise |
| B-hrcub | 1.16 / 2.46 | 1.39 / 1.94 | −0.2 | within year-noise |
| B-h2 / B-hrcub-h2 | 1.16 / ~2.45 | 1.48 / 2.30 | −0.1 | within year-noise |

Out-of-frame, every B form is indistinguishable from the deployed quad (B-hrlin trades pooled worse
for top slightly better; B-h2 makes BABIP worse). **Why, structurally:** league in-frame is already
calibrated and own-gap-lifted tournament ratings stay IN-DOMAIN — so any form that fits league
equally well produces the same in-domain predictions. A league-fit form change *cannot express* an
out-of-frame correction. The "form is maxed" claim survives its slope-first-class retest **for this
defect class**; the fix must be gap-conditioned.

### A. Gap-conditioned event-space correction — **WORKS; needs THREE legs**

Families per channel (all monotone; strength λ·w(g), g = k−1 from the own-gap pool-transform
mean-scalar for the driving rating; w = g or saturating 1−e^(−g/0.10); identity at g=0 exactly):
hinge(p75), hinge(p50), quad (convexity, clamped), pivot (kSpread class), step (tanh mid-band).
λ per channel by grid on slope loss = 2(pooled−1)² + (top−1)² + (rest−1)²; archetypes/ordering are
acceptance-only, never fit targets.

Sweep outcomes (both catalog snapshots): **HR → hinge-lin** decisively; **BABIP → hinge-sat**
(hinge50-lin statistically tied); **SO → step** (lin/sat tied; sat matches the tier-stable 1.16
slope). Pivot retest: mid-pack for BABIP, wrong for HR — the "scalar provably wrong for HR" claim
CONFIRMED with numbers (pivot-lin HR: pooled 0.87, top 1.10, rest 0.77 — breaks the middle).

**HR+BABIP alone un-cancels elite power** (+1.9*..2.1* CI-clear): the SO leg of the original
cancellation (+1.2) is left exposed — exactly as the ledger predicted. The SO step leg (mid-band
stretch; both calibrated ends untouched — the inverse-tail instrument the MMSE fork demanded)
restores it. λSO is small (0.30 sat ≈ tier-flat lw ≈ 0.17–0.30).

### The PINNED operating point (what production ships, dormant)

The loss-fit λHR (2.60–2.75 by snapshot) over-corrects pooled slope to 0.95 [0.92,0.99] buying
top-band exactness — a real one-knob trade. The §3b sensitivity sweep with bootstrap CIs shows a
**gate-clean λHR band: 1.6–2.3 (cdmx) / 2.0–2.35 (oaxaca)** ⇒ pinned mid-band:

```
PINNED_HIT_TAIL (src/scoring-core/hit-tail.ts):
  HR:    hinge above pool p75, gap-LINEAR,  λ = 2.20
  BABIP: hinge above pool p75, SATURATING,  λ = 1.10
  SO:    step (tanh mid-band), SATURATING,  λ = 0.30
```

**A-PINNED passes 7/7 pre-registered gates** (final run, N=358 well-sampled hitters, 5 Quick tiers):

| axis | baseline | A-PINNED |
|---|---|---|
| HR600 pooled slope | 1.16 [1.11,1.22] | **0.97 [0.94,1.01]** |
| HR600 elite top-band | 2.44–2.46 | **1.16 [0.81,1.43]**, Δ(top−rest) +0.25 n.s. |
| HR Q4-POW bias (pooled) | −1.94* (iron −3.57*) | **+0.35 n.s.** (iron −0.10) |
| BABIP pooled slope | 1.39 [1.24,1.56] | **0.99 [0.92,1.06]**, top 0.99 |
| SO% pooled slope | 1.16 | **1.01 [0.99,1.04]** |
| composite ordering (pooled wOBA corr) | 0.667 | **0.710, Δ +0.048 [+0.026,+0.073] CI-clear IMPROVED** |
| elite-power (level-free) | −0.2 (by cancellation: hr −3.6 / bab +2.6 / so +1.2) | **+0.64 [−0.68,+2.00], drivers hr −0.6 / bab +0.9 / so +0.4 — RESOLVED, not moved** |
| contact | −1.84* | **−0.66 n.s.** |
| whiff-slugger | −2.17 (hr −5.9 / so +3.8) | **−0.83 n.s.** |
| walk-machine | +0.59 | +0.02 |
| held-out tier (λ refit on 4, judged on 5th) | — | holds every tier (HR 0.81–1.12, BAB 0.74–1.17, SO 0.95–1.08) |
| league identity | — | exact (g=0 ⇒ lw=0, verified numerically + pinned by test) |
| weird-env (3 dailies, global λ) | — | HR right-way everywhere (goldcap Q4 −6.78*→−5.30*, bronzeheart −1.17→−0.10, earlygold −1.49*→−1.21*); BABIP slopes 1.43/1.65/1.24 → 0.80/1.17/0.87 |

## 3. Implementation (wired, DORMANT — Derek activates)

- `src/scoring-core/hit-tail.ts` — the ONE copy: `correctChannel` (5 families), `applyHitTail`
  (event-layer: SO′/HR′ then BABIP measured on old BIP, corrected, re-applied on the new BIP;
  hit mix preserved), `computeHitTail` (pool-property state: gaps from the SAME ref/pool field
  stats as the own-gap lift; channel moments from the eligible VLvl-0 hitter pool's blended
  predicted lines), `PINNED_HIT_TAIL`. The bake-off tool imports these functions — fit and
  production share one implementation.
- Seam: the kSpread seam — post-model, pre-era, pre-BIP-chain, in `score-card.ts` AND
  `calibrate.ts` augment (anchor sees the same corrected events). Hitter side only; pitcher paths
  untouched (BUILD-1 owns those).
- Config: `ScoringConfig.hitTail?` + `Tournament.hitTailCorrection?: boolean`. **Absent ⇒
  bit-identical scores** (dormancy pinned by test). Server builds the state on the own-gap path
  only, per tournament, when the flag is true. NOTE: the server.ts hook was held out of the module
  commit while BUILD-1's K-spread server wiring was in flight in the same file (see git log).
- Tests: `tests/hit-tail.test.ts` — 14 invariants (dormancy-exact, league identity, monotonicity
  of every family at extreme strength, BIP consistency + hit-mix preservation, pitcher-path
  never-touched sentinel, pinned constants).

To activate: set `"hitTailCorrection": true` on a tournament JSON (start with one Quick tier and
Regenerate; no retrain needed — the correction is post-model).

## 4. Activation design — per-tournament opt-in as wired; on-by-default is DEREK'S RULING

As wired: `Tournament.hitTailCorrection: true` per tournament (dormant everywhere until set).

**Case FOR on-by-default** (flag flipped to an opt-out kill-switch, ~3 lines, mirroring BUILD-1's
`kSpreadPit` pattern): 7/7 pre-registered gates including held-out-tier and directional weird-env;
identity in-frame by construction (league/unrestricted pools mathematically untouched — the failure
mode of a bad default is bounded to out-of-frame pools, which are exactly where the defect is);
composite ordering IMPROVES CI-clear (+0.048), so it is not a spacing-vs-ordering trade; and the
sibling BUILD-1 K-spread shipped on-by-default on a strictly WEAKER gate record (its G2 gold-quick
cell failed and was overruled).

**Case AGAINST**: λs were fit and judged on the same 5-tier cwhit sample (held-out-tier is internal
OOT, not a second dataset); the era-2010-ish daily BABIP slope overshoot (0.80/0.87) is a real
directional wart; the BABIP/SO level footprints interact with the pending format-constant program;
the blended-vs-per-side approximation is unmeasured at card grain; and BUILD-1 just changed pitcher
scores — activating two scoring changes simultaneously muddies attribution of anything Derek sees
change on 5173. Program doctrine is one defect per cycle.

Not decided here. A staged path exists either way: activate on one Quick-tier tournament, watch a
few dailies' worth of cwhit data, then broaden.

## 5. Caveats and residuals (carry these, not landmines)

1. **The Q2/Q3 mid-POW hump remains** (+1.45*/+1.76* pooled, unchanged): no monotone upper-tail
   instrument lowers mid-power predictions; the quad/convexity family that could was clamp-limited
   and lost. This residual is bounded, CI-known, and orthogonal to the elite-tail fix. A future
   mid-shave would need a different instrument.
2. **Level footprints**: BABIP hinge adds ~+0.007 to the judged top-100's level bias (+0.009→
   +0.016); SO remains over-predicted in level (+2.1–2.3 pp; the step leg helps slightly). Uniform-
   within-role level is Ruling-1 convention and the tournament format-level constants are a
   separate (quarantined) program — but any future format-constant fit must be measured ON TOP of
   this correction.
3. **Weird-env BABIP overshoot** at the two era-2010-ish dailies (slopes 0.80/0.87) — directional,
   N-thin, flagged for Derek; possibly g interacting with era factors. HR is right-way everywhere.
4. **Fit/judge share the 5-tier cwhit sample** — held-out-tier is the honest OOT; no second
   external dataset exists at this depth. The λs are frozen; re-fit only as a deliberate cycle.
5. **Blended-vs-per-side**: λs were fit on exposure-blended lines; production corrects each side
   with the same pool moments. Hinge convexity ⇒ platoon-split cards straddling the pivot get
   slightly MORE correction than the fit implies (Jensen); second-order, monotone-safe.
6. Diamond hit N=17 (thin), diamond pit dead as always. cwhit projections were never used.
