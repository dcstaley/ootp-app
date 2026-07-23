# BUILD-2 hitter-tail refit — PRE-REGISTRATION (C3 constants event, extend per Fable option (a)).

**2026-07-22. Written BEFORE any fitting, for Fable's approval. No fit runs until this is approved.**

C6 found three stale hitter-tail failures on the core: **Iron Quick SO% 1.05 [1.01,1.11]**, **Bronze
Quick HR600 0.88 [0.83,0.92]**, **Silver Quick BABIP 0.80 [0.66,0.94]**. The BUILD-2 hitter tail
(`PINNED_HIT_TAIL`) has been standard scoring since 2026-07-17, and its 7/7 gate record was
established at the PRE-C1/C2′ coordinate — it was never re-fit when C1/C2′ moved the axis. Per Fable
option (a) and the atomic-event rule, it is refit here on the current coordinate.

---

## 1. THE CLAUSE-4 AUDIT (every inherited rule is a defect until re-derived)

`tools/hit-tail-bakeoff.ts` fits `PINNED_HIT_TAIL` — a per-channel (HR / BABIP / SO) correction, each
a family × gap-shape with a strength `λ` fit on a calibration-slope loss, gap-conditioned by
`g = k − 1` (the own-gap mean-scalar). Auditing:

**A. THE ESTIMAND — the slope loss conflates level and spread for the non-level-preserving families
(ruling (z), in the hitter tail's own terms).** The strength `λ` is fit to drive the calibration slope
to 1. That is a free-slope target — BUT the winning families are NOT level-preserving. `hinge`
stretches one-sided above the pool p75, which RAISES the mean; `step` stretches the mid-band. When the
judged sample sits off the pool percentile the correction pivots on, the slope loss prices the LEVEL
move those families produce, not only the spread. This is ruling (z)'s conflation wearing a different
family. **RE-DERIVED:** the slope loss is computed with a PER-TIER FREE LEVEL — de-mean pred and obs
within tier before the slope, so `λ` is chosen for the spread/ordering response the anchor does not
own, exactly as C3's free-slope estimand does for a scalar. (`pivot` is already level-preserving and
is unaffected; the change matters for `hinge`/`hinge50`/`step`, which are the ones that shipped.)

**B. THE INSTRUMENT — the phantom pre-C2′ coordinate (§15.8 exhibit 4).** The tool builds fields with
`computeUnifiedFieldStats(pool, …, FIELD_N, true)` — variant-free, unscaled `FIELD_N`, NOT the
presence mixture production now scores on. Every pool percentile (p75, median, sd), every channel
moment, and `g = k − 1` are therefore on a coordinate production no longer uses. **RE-DERIVED:** the
refit builds all of it through `productionFieldStats` at the presence mixture, so the correction is
parameterised by production's coordinate, not a fork.

**C. THE FAMILY — re-run the bake-off; do NOT inherit `PINNED_HIT_TAIL`'s family choices, and RETEST
the structural claims rather than carrying them.** BUILD-2 concluded (i) form-change is dead by a
structural proof (league in-frame is calibrated, so any league-fit form gives the same in-domain
predictions), and (ii) the winning triple was HR hinge-p75 / BABIP hinge-p75-sat / SO step. Both were
established on the old coordinate. The structural proof (i) is coordinate-INDEPENDENT and is expected
to survive, but it is RE-STATED and re-checked, not assumed. The family choices (ii) are re-selected
by the bake-off on the current coordinate — a moved axis can change which family calibrates.

**D. SELECTION — the λ-grid-on-slope-loss argmin does not survive as-is.** `λ` is currently the single
argmin of a slope loss. **RE-DERIVED:** `λ` per channel is selected by deliverable-space equivalence
— the equivalence set is every `λ` whose implied per-tier calibration slopes differ by less than the
per-tier need SE, the shipped `λ` is the set's minimax centre, and the set is published. Set-at-grid-
edge (`λ` running to 0 or the grid top) = family misfit for that channel.

**E. FORMAT REACH — legacySlug, not the registry.** Same `formatByLegacySlug` defect; RE-DERIVED to
resolve held-out formats from the corpus registry by `tournamentId`.

**F. WHAT IS NOT TOUCHED.** BB% is a watch-only channel (mildly over-spread, no retrain cycle
warranted) and carries no shipped tail correction — out of scope. wOBA is a downstream summary, never
a fit target. The pitcher corrections (K, HR) are the other two legs of the atomic event, fit under
their own preregs; here they are held ACTIVE as baseline so the hitter residual sits on the shipping
reality.

---

## 2. THE COORDINATE AND THE THREE CHANNELS, MEASURED FIRST

`g = k − 1` per channel (HR ← POW gap, BABIP ← BABIP gap, SO ← avoid-K gap) tabulated per Quick tier at
p = 0/0.25/0.30/0.35 as the first output, with the ordering/span identifiability prong checked BEFORE
any fit. Each channel's per-tier calibration need (the free slope) is re-measured on the current
coordinate and recorded before the fit is scored.

---

## 3. THE FIT

**Correction seam:** unchanged — `computeHitTail` / `applyHitTail`, the ONE copy, at the production
placement (raw side events, post-model, pre-BIP, pre-era). Only the FITTED constants (`PINNED_HIT_TAIL`
families + `λ`) and the coordinate they are fit on change.

**Estimand:** per-channel calibration slope with a PER-TIER FREE LEVEL (§1.A), gap-conditioned strength
`λ·w(g)` on the production coordinate.

**Selection:** deliverable-space equivalence per channel, minimax-centre `λ`, sets published.

**The paired-channel constraint stays (BUILD-2's finding):** HR and BABIP un-cancel elite power only
when fit together — the ledger showed fixing one alone flips elite power over/under-valued. The refit
keeps HR+BABIP paired and reports the joint elite-power residual, so a per-channel `λ` can never ship
that re-opens the cancellation.

---

## 4. GATES (current coordinate/bars; nothing inherited)

1. **IDENTIFIABILITY** (ordering + span ≥ 60%; equivalence-set-interior per channel; leave-one-tier-out
   in deliverable space).
2. **G1-HIT ACCEPTANCE:** post-correction HR600 / BABIP / SO% calibration slopes inside the measured CI
   on the coherent tiers, diamond-mandatory rule set once the needs are measured. These three are the
   C6 failures, so they are first-class.
3. **PAIRED-CHANNEL / ELITE-POWER:** the joint HR+BABIP elite-power residual CI must cover 0 — the
   cancellation stays resolved, not moved (BUILD-2's decisive gate).
4. **G2 ORDERING MUST NOT DROP CI-CLEAR**, every stratum, on the hitter composite.
5. **PITCHER BIT-IDENTITY:** the hitter tail is hitter-only; every pitcher line bit-identical pre/post
   (C6 already checks this direction — 3539 rows, max |Δ| 0.0e+0 — and it stays a STOP).
6. **BAND re-check p = 0.25 / 0.35**; **provenance stamped + asserted** (`fitN`, `fitP`).
7. **HELD-OUT** dailies + budget from the registry, DIAGNOSTIC not gate.

Any gate failing ⇒ STOP and report; overrules are Fable's or Derek's.

---

## 5. WHAT SHIPS

On a pass, `PINNED_HIT_TAIL` is replaced with the re-selected families + `λ` on the current
coordinate, with provenance stamped. It ships in the SAME dated commit as C3 and the HR refit — the
atomic-event rule — and the final C6 sweeps the coherent triple before anything is announced to Derek.

(end of pre-registration — hitter-tail refit)
