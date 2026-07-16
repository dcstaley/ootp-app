# Pitcher K-spread spacing correction — fit + gates (2026-07-16, BUILD-1)

Tool: `tools/fit-kspread-pit.ts` (run: `node tools/fit-kspread-pit.ts`; seeded — reruns reproduce
every number). Evidence base: `docs/CWHIT_MMSE_BATTERY_2026-07-16.md` (pit K9 slope 1.73 [1.65,1.80]
pooled, FLAT across quality, monotone in gap; value stake 4.6 mwOBA/card — the program's #1).

**What this is:** the evidence-backed resurrection of the K-spread class as a STANDALONE
multiplicative spread scalar on the CURRENT own-gap scoring path —
`K_corr = K̄_pool + s(gap)·(K_pred − K̄_pool)`, `s(g) = 1 + A·(1 − e^(−g/G))`, `s(0) = 1` hard
(league-anchored: in-frame K is already calibrated per `insample-frame-check`). Applied to the raw
model K pre-BIP pre-era via the surviving `kSpread` plumbing (score-card.ts / calibrate.ts).
**What this is NOT:** the refuted frame-v2 kSpread — that died as part of the additive-frame
package; own-gap + standalone K-spread had never been tested.

Conventions (all property-derived at scoring time; NO per-tournament constants):
- gap = `buildFrameShift(trainingMeans, poolField).pit.vR.stu` (the established own-K-channel gap —
  same number `tools/tournament-kslope.ts` / `tools/fit-sgap.ts` used).
- K̄_pool = `poolMeanKOwn(basePool, coeffs, model, poolTransform, 50).pit` — NEW own-gap sibling of
  `poolMeanK` (same top-50 cohorts, own-gap-transformed ratings, pre-era K/600).
- Eval path = `buildCwhitSample` (the scorecard's exact data/join/prediction path), extended with an
  optional pitcher-only `kSpreadPit` that mirrors production placement per side and re-derives
  non-HR hits from the corrected BIP via the fitted H-curve (exactly the deployed recompute).

## 1. Per-tier measurement (model `league-41-42-pareto`, catalog `oaxaca`)

| tier | N | gap(stu) | K̄_pool/600 | slope [boot CI] | corr | ratioRaw/Dcv | optRatio |
|---|---|---|---|---|---|---|---|
| iron | 44 | 27.7 | 121.9 | 1.90 [1.76,2.03] | .979 | 0.52/0.52 | 0.98 |
| bronze | 52 | 25.7 | 120.1 | 1.70 [1.60,1.80] | .970 | 0.57/0.57 | 0.97 |
| silver | 22 | 22.5 | 120.3 | 1.51 [1.05,1.68] | .955 | 0.63/0.64 | 0.96 |
| gold | 15 | 19.3 | 120.7 | 1.43 [1.13,1.73] | .944 | 0.66/0.68 | 0.98 |

Diamond pit N=1 — excluded (known dead cell). Reproduces the MMSE battery exactly.

## 2. Fitted ramp (precision-weighted, s(0)=1 hard)

- **G is only LOWER-BOUNDED.** The tiers span g ≈ 19–28 only, and there the profile degenerates to
  the linear limit `s = 1 + 0.0287·g` (SSE 5.85 vs best exponential 6.08→5.9 as G→∞). Only s at the
  observed gaps (≈ A/G ≈ β) is measured; the saturation scale is not.
- **Shipping pin** (rule, not eye: most-saturating member within 5% of the linear-limit SSE — the
  least extrapolated amplification beyond observed gaps): **A = 9.539 [2.10, 12.27], G = 319
  [60, 399]** — the A/G CIs are wide and strongly coupled (only the ramp VALUES are pinned):
  s(10)=1.29 · s(20)=1.58 · s(28)=1.80 · s(35)=1.99.
- s at tier gaps, ±boot CI: iron 1.79 [1.70,1.88] (measured 1.90), bronze 1.74 [1.66,1.82] (1.70),
  silver 1.65 [1.58,1.72] (1.51), gold 1.56 [1.50,1.63] (1.43). The ramp overshoots the thin
  silver/gold cells by +0.14–0.15 (inside/near their own CIs; iron/bronze dominate the weights).

## 3. Held-out validation — PASS

Fit without bronze (the deepest tier): predicted bronze slope **1.77 [1.64, 1.87]** vs measured
**1.70 [1.60, 1.80]** — statistically one number.

## 4. Two-axis gate (quicks, shipping candidate = refit-with-all)

Hitter identity check: 499 hitter recs bit-identical pre↔post (pitcher-only by construction ✓).
K9 within-pool ordering: 0 rank moves at every tier (monotone by construction, verified) ✓.

| tier | G1 K9 slope pre→post [CI] | G2 wOBAA corr pre→post (Δ [CI]) | G3 K9 level pre→post | G4 ratioDcv → (opt) |
|---|---|---|---|---|
| iron | 1.90 → **1.06 [0.98,1.13] PASS** | .681 → .746 (+.065 [−.02,+.16]) PASS | +0.59 → +0.19 | 0.52 → **0.93** (0.98) |
| bronze | 1.70 → **0.97 [0.92,1.03] PASS** | .765 → .712 (−.053 [−.16,+.05]) PASS | +0.74 → +0.55 | 0.57 → **1.00** (0.97) |
| silver | 1.51 → **0.91 [0.64,1.02] PASS** | .843 → .822 (−.021 [−.12,+.05]) PASS | +0.74 → +0.92 | 0.64 → **1.06** (0.96) |
| gold | 1.43 → **0.91 [0.72,1.12] PASS** | .806 → .627 (**−.179 [−.43,−.04]) FAIL** | −0.10 → −0.18 | 0.68 → **1.07** (0.98) |
| POOLED | 1.73 → **0.99** | .748 → .732 (−.016 [−.073,+.040]) PASS | — | — |

- **G1: PASS everywhere** — pooled 1.73 → 0.99. The headline defect is closed on the quicks.
- **G4: PASS everywhere** — deconvolved spread ratios land ON the MMSE optimum (0.93–1.07 vs
  optRatio 0.96–0.98) from 0.52–0.68.
- **G3:** levels move ≤0.4 K9, mixed sign, ≈ the algebraic selection term (s−1)·(K̄_sample−K̄_pool)
  plus the hits-recompute; composite level remains anchor-absorbed (Ruling-1 scope).
- **G2: one CI-clear FAIL — gold quick (N=15).** Characterization (not tuning):
  - LOO-robust: 0/15 single-card drops flip Δ to ≥0 (range −0.26..−0.13) — not one influential card.
  - **Oracle-s diagnostic** (s = each tier's own measured slope; per-tier constants are
    mission-illegal, characterization only): gold still fails (Δ −0.130 [−0.31,−0.02]) ⇒ the drop is
    NOT ramp overshoot — at gold, de-shrinking K inherently degrades this sample's composite
    ordering (the K→BIP→hits coupling moves wOBAA in a direction gold's observed composites don't
    reward). Iron/bronze/silver oracle Δ: +0.06 / −0.05 ns / −0.005 ns.
  - **Does not replicate at matched gap on independent data:** gold-cap daily (same VAL cap, same
    gap 19.3, same era, N=14) shows Δ −0.012 [−0.095,+0.013] PASS.

## 5. Weird-env battery (dailies; DEPLOYED per-channel line, era/park applied)

diamondcapdaily EXCLUDED (Derek: no config). Gap + K̄_pool computed from each format's own eligible
pool (VAL cap + eligibility rules), exactly as production would.

| format | gap | s | era_k | N | K9 slope pre→post [CI] | wOBAA corr pre→post | ratioDcv → |
|---|---|---|---|---|---|---|---|
| Early Gold Daily (era-1920/park-169) | 19.8 | 1.58 | 0.352 | 24 | 2.30 → **1.45 [1.34,1.57] FAIL** | .731 → .750 (+.020) PASS | 0.43 → 0.68 |
| Bronze Heart Daily (era-1939/park-191) | 22.6 | 1.66 | 0.411 | 12 | 2.39 → **1.44 [1.22,1.77] FAIL** | .502 → .469 (−.033 ns) PASS | 0.41 → 0.68 |
| Gold Cap Daily (era-2010/park-156, cap 1580) | 19.3 | 1.57 | 1.000 | 14 | 1.65 → **1.06 [0.95,1.17] PASS** | .952 → .940 (−.012 ns) PASS | 0.60 → 0.94 |

**The residual is an ERA effect, not a gap effect.** At neutral era (gold-cap) the fix lands the
slope on 1 at the same gap where the two extreme-era formats stop at ~1.44. Pattern: pre-slope at
matched gap is inflated by ≈ era_k^(−γ), γ ≈ 0.35–0.41 on these two points — i.e. `era_k` (0.35/0.41
in those eras) compresses PREDICTED per-card K spread proportionally, but the OBSERVED card-to-card
K spread shrinks much less than proportionally. That is a **separate, era-conditioned spread defect
in the environmental layer** (two points only — flagged, NOT fit; out of this build's pre-registered
scope). The gap-conditioned component itself behaves identically at weird eras (removes the same
ratio of slope as at the quicks).

## 6. Verdict + disposition (pre-registered rules applied)

Gate record: **G1 4/4 quicks + pooled PASS, gold-cap PASS; G1 FAIL residual at the two extreme-era
dailies (era channel, §5). G2 pooled + 3/4 quicks + 3/3 dailies PASS; CI-clear FAIL at gold quick
(N=15, LOO-robust, non-replicating at matched gap). G3 small anchor-absorbed moves. G4 PASS
everywhere.**

Per the pre-registration ("production wiring only if gates pass"; "never tune past a failed gate"):
**production wiring did NOT proceed.** Nothing on the production scoring path changed
(`applyKSpread`'s s===1 short-circuit is the one production-code touch — an exact-identity
strengthening that changes no active score). What landed:

- `src/scoring-core/pool-stats.ts` — `poolMeanKOwn` (own-gap K̄_pool centering; shared internal with
  `poolMeanK`, one copy of the math).
- `src/model/pool-transform.ts` — `applyKSpread` s===1 exact short-circuit (bit-identity in-frame).
- `src/eval/cwhit/sample.ts` — optional pitcher-only `kSpreadPit` on `ourPit`/`buildCwhitSample`
  (production placement, per-side, hits re-derived from the corrected BIP; hitters untouched).
- `tools/fit-kspread-pit.ts` — the full instrument (measurement, fit, held-out, oracle/LOO
  diagnostics, weird-env battery, gates). Deterministic.
- `tests/kspread-pit.test.ts` — 12 synthetic-fixture tests: s=1 bit-identity (unit + scoreCard on
  the own-gap path), pitcher-only isolation, poolMeanKOwn ≡ poolMeanK under identity re-basings +
  lift response, ourPit monotonicity/physical-composite/BABIP-rate invariants.

**Ready-to-execute wiring spec** (unchanged from the plan, pending Derek's ruling on the gate
record): own-gap branch of `scoreTournament` computes `gap` (buildFrameShift on the artifact's
trainingMeans vs the pool field) and `kSpread = { sHit: 1, sPit: 1 + A·(1−e^(−gap/G)), meanHit,
meanPit: poolMeanKOwn(...).pit }` behind a default-OFF state flag, threading the same object into
`calibrate`/`calibrateBasic`; constants `A = 9.539, G = 319` (the §2 pin). Derek's calls: (a) accept
the gold-quick G2 exception (pooled ordering passes; the cell is thin and non-replicating) and wire;
(b) hold for the era-spread follow-up (§5) first; or (c) reject the instrument.

## 7. 2026-07-17 — Derek's ruling: WIRED, ON BY DEFAULT (option (a), inverted to standard scoring)

Derek overruled the gold-quick G2 exception (pre-declared thin cell, non-replicating at matched gap
in gold-cap daily, instrument-inherent per the §4 oracle-s test) and ruled the ramp into the
**standard scoring path** — not an opt-in flag. Wiring as executed:

- **Constants:** `K_SPREAD_PIT = { A: 9.5394, G: 319 }` + `kSpreadPitRamp(gap)` in
  `src/model/pool-transform.ts` (next to `applyKSpread` — the one home of this transform family,
  exported through `scoring-core/index.ts`), with the full fit provenance in the comment.
  `s(g ≤ 0) = 1` exactly.
- **Path:** own-gap branch of `scoreTournament` (`src/server/server.ts`) computes
  `gap = buildFrameShift(activeTrainingMeans, poolField).pit.vR.stu` and
  `kSpread = { sHit: 1, sPit: kSpreadPitRamp(gap), meanHit/meanPit: poolMeanKOwn(...) }`, threaded
  into `scoreCard` + `calibrate` + `calibrateBasic` via the existing plumbing (verified placement:
  raw K, per side, pre-BIP pre-era; hits re-derive from the corrected BIP in the components
  recompute). The `/api/tournament/scorecard` own-gap mode carries the same object, so eval mirrors
  production. Requires a trainingMeans-bearing model; absent ⇒ ramp skipped + activation warning.
- **KILL-SWITCH (rollback):** `state.kSpreadPit = "off"` — `POST /api/training/kspread-pit?enabled=false`
  (re-enable with `?enabled=true`); `GET /api/training/kspread-pit` reports
  `{ enabled, hasTrainingMeans, A, G }`. Unset/`"on"` = enabled (the default).
- **Tests** (`tests/kspread-pit.test.ts`, 17): constants pinned exactly; ramp values at reference +
  tier gaps as regression expectations (s(20)=1.58, s(27.7)=1.79 …); s(0)=1 structural bit-identity
  via the s===1 short-circuit; monotone + plateau-bounded; scoreCard in-frame identity on the
  own-gap path; pitcher-only isolation (hitter scores bit-identical under sPit>1).

**Expected behavior change (intended):** on next Regenerate, pitcher scores in weak-pool (out-of-
frame) tournaments re-space — elite-K arms up, control-soft/low-K arms down (the Donohue-class
correction); in-frame pools are bit-identical. Hitters are untouched everywhere. The era-spread
residual (§5: EG/BH stall at slope ≈1.44) is a known SEPARATE queue item, unchanged by this wiring.
