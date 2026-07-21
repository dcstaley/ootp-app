# Centerpiece #2 — the rating-local error profile e(r). PRE-REGISTRATION.

**2026-07-21. Written BEFORE any fitting.** Nothing in this document is a result. It fixes the
construction, the coordinate, the bar, the held-out design and the kill conditions in advance,
because the quantity being tested (a per-tier calibration slope) is a summary of the same data the
function would be fitted on, and that is exactly the setting where a post-hoc bar is worthless.

No wiring, no constants, no production change follows from any outcome here. The ruling on what — if
anything — replaces the ramp happens upstream.

---

## 1. The hypothesis

The K need is a **rating-local error of the K curve**, not a property of the opposing field.

The model is trained on league cards. Tournament pools live below that range. If the fitted K curve's
slope is deficient in the region where tournament cards actually sit, then predicted card-to-card K
spread is compressed there, and a pool's measured calibration slope is just **the local slope of that
error over the cards that pool plays**.

It is the standing candidate because it accounts, with one mechanism, for five things that have
resisted a single explanation:

| observation | what this hypothesis says |
|---|---|
| needs are CONVEX in gap for the coherent four | the error's local slope varies smoothly with rating; gap is a proxy for rating position and a lossy one |
| diamond ≈ 1.04 | diamond's cards sit closest to the training range, where the error is ~0 |
| K is INSENSITIVE to the opposing field (battery item 1, all three weightings, moves < 0.01) | the defect is on the pitcher's own coordinate — the opponent never enters it |
| gold is off any 1-D gap curve (1.78 at gap 15.9) | gold's *realized* set samples the error region differently from what its gap implies |
| BUILD-1's constant-s worked at all | a constant is the average of the local slope over the pools it was fitted on |

It also makes the fix **per-card and ex-ante** — no usage weights, no tier identity, no pool ramp —
which is why it is worth a careful test rather than a quick one.

---

## 2. STEP 0 — the structural precondition, run and reported BEFORE anything is fitted

**BUILD-2 already killed the analogous hitter story with a structural proof:** league in-frame is
calibrated and own-gap-lifted ratings stay *in-domain*, so any league-fit form gives the same
in-domain predictions and a form change cannot express an out-of-frame defect
(`docs/CWHIT_HITTAIL_BUILD2_2026-07-17.md`). The pitcher K equivalent has never been checked.

The deployed K curve stamps its own fit domain: `eventForm.pit.k` has `mu = 120.83`, `sd = 21.05`,
`uMin = -2.415`, `uMax = 3.144` — i.e. the curve was fitted over stuff ratings **~70 to 187**, with a
training mean of `trainingMeans.pit.stu = 129.46`.

**Measure, per Quick tier, where each realized well-sampled pitcher's EFFECTIVE stuff coordinate sits
in that domain** — effective stu being `applyAffine(Stuff v{R,L}, poolTransform.pit.v{R,L}.stu)`, the
exact argument `ourPit` feeds the curve, per side.

Report: the tier's effective-stu distribution in z units (min / p10 / median / p90 / max), the share
below `uMin`, and the share below z = -1.

Three outcomes, all pre-committed:

- **Cards sit largely OUTSIDE the fitted domain (below uMin).** The literal extrapolation reading is
  live; the tangent-linear extension is the thing under suspicion.
- **Cards sit INSIDE the domain but concentrated in its sparse LOW tail.** The hypothesis survives in
  its weaker and more likely form — *rating-local* error from thin training support, not
  extrapolation past an edge. Everything below still applies; the write-up must stop calling it
  extrapolation.
- **Cards sit in the well-supported middle of the domain.** The hypothesis is in serious trouble
  before it is fitted, for the same structural reason BUILD-2 gave. **STOP and report.** Do not
  proceed to the fit "to see".

Training *density* (as opposed to the domain edges) is not recoverable from the model artifact —
`ratingEnvelope.pit.stu = 187` is the training max only. If density is needed to read the second
outcome, it comes from Derek's league exports at `datasetRoot`, and that is a separate measurement to
be stated as such, never inferred from the artifact.

---

## 3. The construction

**Coordinate — fixed now, not chosen later.** `r` = effective stuff, per side, as defined in step 0.
The correction is applied **per side and then blended by the same exposure weights `ourPit` uses**,
because the curve is evaluated per side. A card therefore contributes one row per (card, variant
level) — a v5 is a different card at a different `r`, never merged into its base.

**Form.** `K_true(r) = K_pred(r) · m(r)`, with `log m` a smooth monotone function of `r` — a
low-order polynomial or a small-knot linear spline, degree pre-declared before fitting and not
revised after seeing the fit.

**One hard constraint, and it is what makes this a test rather than a recalibration:**
`m(r) ≡ 1` for `r ≥ r_train`, where `r_train` is set by step 0's reading of the training support.
Pinned, not fitted. Without it, `m` is free to absorb any level or spread error anywhere and the
exercise proves nothing.

**No tier terms. No pool terms. No opponent terms. No era terms.** One function of one rating
coordinate, fitted on the pooled per-card rows of the Quick tiers only.

**Quicks only for fitting** (Fable's standing clarification): the dailies carry era, and fitting on
era-bearing formats launders the era residual into whatever is being measured. Early Gold, Bronze
Heart, Gold Cap and Diamond Cap stay held-out evaluation legs.

**Realized sets must be the variant-corrected ones** (`src/eval/cwhit/realized.ts`, landed today).
Any pre-fix number is on a field missing 15–29% of its usage.

---

## 4. The estimand and what "reproduces" means

For tier *t*, the implied calibration slope is the regression slope of the corrected prediction on
the uncorrected one over **that tier's own realized well-sampled cards** — the same cards, the same
BF floor and the same estimator the measured needs come from (`tools/fit-kspread-pit.ts` section 1:
`mmse()` slope of obs~pred, seeded bootstrap `B = 2000`, `SEED = 20260716`).

Measured needs to reproduce: **iron 1.82 / bronze 1.62 / silver 1.48 / gold 1.78 / diamond 1.04**.

The test is not "does a flexible function fit these points". It is whether **one 1-D function of one
rating coordinate, pinned to identity in the training range and carrying no tier information, can
generate five different local slopes at five different card distributions — including one that breaks
monotonicity in gap.**

---

## 5. Pre-registered bar

**PRIMARY (both required).**

- **P1 — within-sample.** Implied slope lies inside the measured slope's bootstrap 95% CI for **at
  least 4 of the 5** tiers.
- **P2 — held-out tier.** Fitted **with gold excluded entirely**, the implied gold slope lies inside
  gold's measured CI. Gold is the held-out tier because gold is the observation that killed the ramp
  family; a version of this that only works with gold in the fit explains nothing new.

**SECONDARY (reported, not gating).**

- **S1 — ordering.** Implied slopes reproduce `gold > silver`, the non-monotone-in-gap signature.
- **S2 — diamond.** Implied diamond slope in `[0.95, 1.15]` when diamond is held out.

**NULL COMPARISONS (required, reported alongside).**

- **N1 — constant slope.** The same fit with `m` constant. It can only produce one slope for every
  tier, so it must lose; report by how much, on held-out-tier prediction error, not in-sample SSE.
- **N2 — coordinate discrimination.** The same fit with `r` = **predicted K** instead of effective
  stuff. If N2 does as well as the pre-registered fit, then this is generic calibration curvature and
  **the "rating-local" claim is not distinguished by the data** — that must be stated as the finding
  rather than buried.

**CONSISTENCY (reported; a violation is a flag, not a pass/fail).**

- `m` monotone toward 1 as `r` rises, and `≡ 1` above `r_train` by construction.
- The implied local slope averaged over the pools BUILD-1 was fitted on should land near the shipped
  ramp's values there (s(20) ≈ 1.58, s(27.7) ≈ 1.79) — the historical constant-s as an average of `e`.

**ROBUSTNESS RIDER.** If the needs turn out to be floor-sensitive (the BF 600/1000/2000 measurement
running in parallel), every gate above is re-read at the floor that measurement recommends, and the
original reading is reported beside it. The bar does not move; the target numbers might.

---

## 6. Kill conditions

Any of these ⇒ **STOP and report the verdict as stated.** No added terms, no coordinate switch after
the fact, no per-tier escape hatch, no "with one more knot".

1. Step 0's third outcome (cards sit in well-supported domain interior).
2. P1 fails.
3. P2 fails — in particular, if the fit reproduces the coherent four and misses gold, the finding is
   that **gold is not a rating-local phenomenon**, which localizes the anomaly rather than explaining
   it, and is a genuinely useful result.
4. A boundary-pinned optimum in any fitted parameter — standing rule: boundary-pinned optimum =
   family misfit, unshippable, and it means the family is wrong rather than the tuning.

A partial pass is a partial pass. The pattern of what reproduces and what does not is the deliverable.

---

## 7. Explicitly out of scope

- Any production wiring, constant, flag or default.
- Any ramp work. The ramp study stays on hold; if this validates, the fix does not live at the pool
  layer at all, and if it fails, the parked interaction hypothesis and its data-acquisition question
  come back.
- Any hitter-side claim. This is the pitcher K channel.
- Any use of realized usage as a shipped coordinate. Realized sets are used to *evaluate* on the
  cards that were actually played, which is what the needs are measured over; the correction itself
  is a function of a card's own rating and is therefore ex-ante by construction.

(end of pre-registration — centerpiece #2)

---

# AMENDMENT 1 — post-step-0, per Fable ruling (a). 2026-07-21.

Appended, not merged into the text above: the original terms stay legible so it is always clear what
was pre-registered *before* step 0 and what was revised *after* it. Where this amendment and §3–§6
conflict, this amendment governs. Still written before any fitting.

## A1.1 What step 0 changed

Step 0 (`fixtures/cwhit-centerpiece2-step0-domain-2026-07-21.txt`) killed the literal extrapolation
reading and showed the typical card is well supported, while the thinly-supported low tail carries
20–51% of each tier's predicted-K variance. Ruling (a): that **narrows the admissible form** rather
than blocking the test.

**The error must be LOCALIZED AT LOW SUPPORT — approximately zero in-range.** A global slope
correction is no longer an admissible candidate: it would contradict step 0's finding that the median
card sits in well-supported territory where the league fit is in-frame calibrated, and it would
re-open BUILD-2's structural objection. If the only form that reproduces the needs is a global one,
that is a **refutation**, not a rescue.

## A1.2 Form — replaces §3's "smooth monotone log m"

Primary, pre-registered and not to be revised after seeing the fit:

    log m(r) = A · max(0, r0 − r)          [one-sided linear hinge]

`r` = effective stuff per side, exactly as §3 defines it. `m ≡ 1` for `r ≥ r0` by construction — the
localization requirement is structural, not fitted. Two free parameters: knot `r0`, slope `A`.

- **`r0` is constrained to lie at or below the league training MEDIAN.** A knot above it is a global
  slope wearing a hinge, and is a **kill condition** (§A1.5), not a result.
- **`A` is free in sign.** The hypothesis predicts the direction that makes low-stuff cards' true K
  fall below prediction (widening observed spread). Leaving the sign free makes the fitted sign a
  genuine test; a fitted sign opposite to the prediction is reported as a refutation.
- **Reported robustness variant, NOT selected on fit:** the same hinge in *training-support
  percentile* rather than raw `r`. It is a different coordinate for the same claim, so it is run and
  reported alongside; the primary form stays primary regardless of which fits better. Choosing
  between them on fit quality after the fact is exactly the move this document exists to prevent.

## A1.3 Fit target — replaces §4's estimand for fitting purposes

**Fit PER-CARD residuals with per-card noise weights.** Target is `obs_k9` vs `pred_k9` at card grain,
weighted by the inverse noise variance already used by the fit tool (`k9Noise(obs, sample)` in
`tools/fit-kspread-pit.ts`). No tier aggregate enters the objective.

**The tier needs become summary DIAGNOSTICS, not fit targets.** This is the substantive change: the
function is never shown the five numbers it has to reproduce, so reproducing them is a genuine
prediction rather than a curve passing through five points it was handed.

## A1.4 Validation — replaces §5's P1/P2

**BOTH BARS. The bar-sensitivity pattern is itself a prediction target.** `e(r)` evaluated on each
bar's realized set must reproduce:

    BF>=600     iron 1.82   bronze 1.62   silver 1.48   gold 1.78   diamond 1.04
    BF>=1000    iron 1.83   bronze 1.64   silver 1.47   gold 1.63   diamond — (N=19, THIN, no verdict)

Diamond is validated at **600 only**, carrying the THIN caveat.

- **P1 (within-sample).** Implied slope inside the measured bootstrap CI for ≥4 of 5 tiers at BF≥600,
  and ≥3 of 4 readable tiers at BF≥1000.
- **P2 (held-out tier).** Fitted with **gold excluded entirely**, the implied gold slope lands inside
  gold's measured CI **at both bars**. Gold remains the held-out tier: it is the observation that
  killed the ramp family.
- **P3 (NEW — the differential).** The implied slopes must reproduce the *pattern* of bar sensitivity,
  not just the levels: **gold moves down materially between bars while iron, bronze and silver hold.**
  A function that reproduces all nine levels but predicts uniform movement across tiers has not
  explained the thing that distinguishes gold.

Nulls (N1 constant slope, N2 coordinate = predicted K) and the consistency checks stand as written in
§5, with the following made explicit per ruling (a): **diamond ≈ 1.0** at BF≥600; **convexity of the
coherent four** at BF≥600; and **BUILD-1's constant-s recovered as the historical average of the
implied local slope over the pools BUILD-1 was fitted on**.

## A1.5 Kill conditions — added to §6

7. The fitted knot `r0` lands at or above the league training median ⇒ global slope in disguise ⇒
   family misfit, and step 0's objection applies unmodified.
8. `A` fits with the sign opposite to the prediction ⇒ refutation, reported as such.
9. P3 fails while P1/P2 pass ⇒ the function explains the *levels* but not gold; report that
   precisely, since it localizes gold to whatever ruling (b)'s classification finds.

## A1.6 Preconditions — this fit does NOT start until both land

- **Ruling (b)'s classification.** If gold's lightly-used cards are new-release-dominated, the
  bar-sensitivity interpretation inverts and gold's target re-anchors near 1.78@600 — which changes
  P2 and P3's targets outright. The fit cannot be validated against targets that are still moving.
- **Item A's sizing.** The variant-policy asymmetry (variant-inclusive training means against a
  variant-free pool mean) biases the gap by construction and tier-variably. Gaps are the x-axis every
  consistency check is read on; if they move, so does the reading.

Both are running. Nothing is fitted before they report.

(end of amendment 1)
