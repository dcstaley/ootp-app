# MMSE / Spacing-Calibration Battery — results (2026-07-16)

Tool: `tools/cwhit-mmse.ts` (run: `node tools/cwhit-mmse.ts`). Rebuilds the spacing battery the
confused session started, as the decisive instrument for Derek's Ruling 2 (events + type bias).
**Salt doctrine applied: every number below is recomputed from the fixtures; nothing inherited.**
Composes committed machinery only: `buildCwhitSample` (the scorecard's exact data/join/prediction
path — RAW event line, own-gap ON, no anchor), `mmse`/`deShrink` from `src/eval/cwhit/two-ledger.ts`,
the scorecard's binomial noise models. Measurement only; no fitting, no scoring change.

Method in one line: an optimally-shrunk (MMSE) predictor satisfies SD(pred)/SD(true) ≈ corr —
equivalently **slope(obs~pred) = 1**, and the slope is **noise-immune** (sampling noise lands in the
residual), so it needs no deconvolution. Slope > 1 CI-clear ⇒ over-shrunk (we under-react by that
factor). CIs = 2000-rep card bootstrap, resampled within tier, re-de-meaned and re-banded per
replicate; the analytic t-CI cross-check agrees on 49/55 cells (all 6 flips are marginal per-tier
cells, listed by the tool; **every pooled headline verdict is CI-method-robust**). POOLED = tier
fixed effects (within-tier de-meaning), so frame-level differences cannot leak into the slope.

---

## 1. Is the under-reaction real? YES — but it is CHANNEL-STRUCTURED, not universal

Pooled (tier fixed effects), slope = calibration slope of obs~pred, [card-bootstrap 95% CI]:

| role | channel | corr raw/dcv | ratio raw/dcv | optRatio | slope [CI] | verdict |
|---|---|---|---|---|---|---|
| pit | **K9** | .968/.974 | 0.56/0.56 | 0.97 | **1.73 [1.65,1.80]** | **OVER-SHRUNK** |
| pit | BB9 | .963/.973 | 0.97/0.98 | 0.97 | 0.99 [0.93,1.06] | MMSE-OK |
| pit | HR9 | .933/.973 | 0.75/0.78 | 0.97 | 1.24 [1.14,1.34] | OVER-SHRUNK |
| pit | BABIP | .835/.991 | 0.68/0.80 | 0.99 | 1.24 [1.11,1.40] | OVER-SHRUNK |
| pit | wOBAA | .748/n-a | 0.58/n-a | n/a | 1.29 [1.09,1.49] | OVER-SHRUNK |
| hit | BB% | .945/.964 | 0.99/1.01 | 0.96 | 0.95 [0.91,0.99] | **OVER-SPREAD** |
| hit | SO%(PA) | .974/.983 | 0.84/0.85 | 0.98 | 1.16 [1.13,1.19] | OVER-SHRUNK |
| hit | HR600 | .896/.921 | 0.76/0.78 | 0.92 | 1.17 [1.12,1.23] | OVER-SHRUNK |
| hit | BABIP | .854/.936 | 0.61/0.67 | 0.94 | 1.39 [1.24,1.56] | OVER-SHRUNK |
| hit | wOBA | .667/n-a | 0.72/n-a | n/a | 0.92 [0.79,1.05] | MMSE-OK |

- **K9 is the monster and the prior session's claim is CONFIRMED, recomputed**: iron K9 corr .979,
  ratio .52, slope **1.90 [1.76,2.02]** (memory said corr ~.95 / ratio .54 / slope ≈1.8). Noise is
  1–2% — deconvolution cannot excuse any of it.
- **Tier trends carry signal.** Pit K9 slope falls monotonically iron→gold (1.90, 1.70, 1.51, 1.43)
  — the under-reaction GROWS with the opponent-frame gap (iron k≈2.2), consistent with a
  GAP-CONDITIONED amplification rather than one flat constant. Hit BABIP runs the other way
  (1.39, 1.22, 1.56, 1.60, 1.73 iron→diamond). Hit SO% is tier-stable (~1.16).
- **Not everything is compressed** — pit BB9 is calibrated, and hit BB% is *OVER-SPREAD* with a tier
  SIGN GRADIENT (iron 1.11 over-shrunk → silver 0.86 / gold 0.79 over-spread): we over-react to walk
  ratings at high tiers. No single scalar even exists for BB%; its stake is tiny anyway (§4).
- **Hitter wOBA composite reads calibrated (0.92) BY LUCK** — over-shrunk SO/HR/BABIP offset
  over-spread BB, echoing the two-ledger cancellation. Composite health is not channel health.

## 2. Flat or tail-concentrated? THE FORK SPLITS BY ROLE

Quartile bands of predicted value (tier-de-meaned, Q4 = elite end), decision statistic =
Δ(top-quartile slope − rest) with bootstrap CI:

| role | channel | pooled slope | Q1..Q4 slopes | Δ top−rest [CI] | fork |
|---|---|---|---|---|---|
| pit | K9 | 1.73 | 1.77, 1.38, 1.71, 1.77 | −0.06 [−0.41,+0.26] | **FLAT — scalar is the right instrument** |
| pit | HR9 | 1.24 | 1.47, −0.02, 1.04, 1.00 | −0.27 [−0.70,+0.37] | FLAT (bands noisy at N=133) |
| pit | BABIP | 1.24 | 0.70, 0.86, 3.00, 0.89 | −0.24 [−0.83,+0.58] | FLAT (bands noisy) |
| hit | SO%(PA) | 1.16 | 0.98, 1.31, 1.32, 0.95 | **−0.26 [−0.36,−0.17]** | **INVERSE-TAIL — elite end already calibrated; a scalar overshoots the top** |
| hit | HR600 | 1.17 | 0.74, 0.85, 1.37, 2.44 | **+1.44 [+0.38,+2.14]** | **TAIL — elite power under-reacts EXTRA; scalar wrong instrument** |
| hit | BABIP | 1.39 | 0.94, 0.96, 1.13, 1.94 | **+0.66 [+0.18,+1.11]** | **TAIL** |

- **PITCHERS: flat.** K9's elite quartile under-reacts exactly as much as the rest (1.77 vs 1.77) —
  a universal per-channel calibration slope fixes it everywhere at once.
- **HITTERS: structured.** Elite HR600 slope **2.44** (vs ~0.8 in Q1–Q2) — the quantitative form of
  Derek's "we undervalue HR hitters", and the slope-space restatement of the prior session's Q4
  cliff (−5.48). Elite BABIP 1.94. A scalar would leave the top wrong and break the middle. SO% is
  the mirror image (mid-range under-reacts, elite end calibrated).
- Reconciliation note: mean-down (quicks HR×0.87 level) + tail-up (Q4 under-reaction) = the
  spread/compression signature, as hypothesized — the HR "sign contradiction" is level-vs-tail, and
  it remains true that no HR fit should proceed until the two level measurements are reconciled.

## 3. cwhit reference column — near-1 IS achievable (directional; he is semi-in-sample)

Same metrics, his projections vs the same observed, same cards (overlap 60–100% per tier, printed by
the tool):

- **His K9: slope 0.89 [0.80,1.01], ratioDcv 1.00–1.18** on the SAME cards where ours is 1.73×/0.56.
- His hit SO% slope 1.01 [0.98,1.04]; hit BABIP 1.07 [0.97,1.17]; HR600 0.92 [0.86,0.98] (slightly
  over-spread); pit BB9 1.07 [0.99,1.16].
- ⇒ **the "irreducible variance / form is maxed" story is materially weakened**: a model on this
  exact prediction problem sits at calibration ≈1 on nearly every channel where we under-react. His
  semi-in-sample status can inflate his ratios honestly, so this is directional — but the MMSE
  verdicts on OUR model (§1) stand on their own and need no comparison.
- We still ORDER composites better (pit wOBAA corr .75 vs his .56; hit wOBA .67 vs .52) — his edge
  is per-channel spacing calibration, NOT discrimination, consistent with the scorecard's shape ties.

## 4. Value-weighted ranking — what fixing each channel's spacing is WORTH

De-shrink each channel to its pooled calibration slope (level-preserving, per tier), push through the
composite wOBA (pitchers via `pitWobaFromChannels`; hitters via each card's own inferred XBH share —
no fixed 0.30 anywhere), SD of the per-card value move:

| rank | cell | slope | SD(Δ value) mwOBA |
|---|---|---|---|
| 1 | **pit K9** | 1.73 | **4.6** |
| 2 | hit BABIP | 1.39 | 3.7 |
| 3 | hit HR600 | 1.17 | 2.9 |
| 4 | hit SO%(PA) | 1.16 | 2.1 |
| 5 | pit HR9 | 1.24 | 1.9 |
| 6 | pit BABIP | 1.24 | 1.2 |
| 7 | hit BB% | 0.95 | 0.5 (over-spread; negligible) |
| 8 | pit BB9 | 0.99 | 0.1 (calibrated) |

K's value effect is indirect (K→fewer BIP→fewer hits) and it STILL tops the table. The BB channels'
miscalibrations are worth ≤0.5 mwOBA — they merit no retrain cycle.

## 5. Instrument recommendation

The fork does not return one answer — it splits by role, and that split IS the deliverable.
**Pitchers:** the under-reaction is real, large, and FLAT — a universal per-channel calibration
slope (the kSpread class, resurrected WITH evidence: 1.73× on K9, the single largest value stake at
4.6 mwOBA/card SD) is the right instrument; the monotone iron→gold slope decline (1.90→1.43) says
the constant should be GAP-CONDITIONED (a function of pool-vs-frame gap — properties-legal under the
mission rule, fit once, external gate = calibration slope →1 at cwhit depth; note league data cannot
supply this fit — in-frame K is already calibrated per `insample-frame-check`, so the amplification
is a tournament-frame parameter by construction). **Hitters:** scalars are the WRONG instrument —
HR600 and BABIP under-reaction is tail-concentrated (elite slopes 2.44/1.94 vs ~1 elsewhere) and SO%
is inverse-tail, so the fix is curve-shape work at the top of the Power/BABIP axes, with the
calibration slope added as a bake-off metric to retest the "form is maxed" rationale (which cwhit's
≈1 ratios on this same data already weaken). Sequence per doctrine (one defect per retrain): pit K9
spread scalar first, then hitter tail form work; leave BB alone everywhere.

## Corrections to the prior session's claims (salt applied)

1. "We under-react ~1.8×" is **K9-specific**, not general — other over-shrunk channels sit at
   1.16–1.39, and the BB channels are calibrated (pit) or over-spread (hit silver/gold). The
   universal-compression framing is wrong; the defect is channel-structured.
2. The flat-vs-tail decision tree ("FLAT ⇒ scalar / TAIL ⇒ form work") resolves **differently by
   role** — neither branch applies globally. Prior framing assumed one global answer.
3. NEW: hit BB% over-spread at silver/gold (slope 0.79–0.86 CI-clear) — we over-react to walk
   ratings at high tiers; converges with the "eye over-credited" archetype slope.
4. Confirmed: iron K9 numbers (stronger, 1.90), HR Q4 cliff (as elite slope 2.44), the MMSE test
   design, and the 0-for-17 spread record's substance.

## Caveats

- Diamond pit is dead (N=1, excluded even from the pool). Silver/gold pit cells are thin (22/15).
- Borderline per-tier cells (verdict flips between CI methods; treat as unresolved): pit BB9 iron,
  pit HR9 silver, pit BABIP iron, hit BABIP diamond, hit wOBA iron/bronze.
- BABIP noise shares run 10–51% — the deconvolved columns are the honest read there; both still show
  compression pooled.
- Top-100-by-usage selection: per the two-ledger tool, per-channel range spans ~106% of pool SD
  (0/36 cells extrapolate) — not binding for these per-channel verdicts.
- cwhit §3 numbers are semi-in-sample (bronze 60% … silver/gold/diamond 100% overlap) — directional
  reference only, never a fitting target.
