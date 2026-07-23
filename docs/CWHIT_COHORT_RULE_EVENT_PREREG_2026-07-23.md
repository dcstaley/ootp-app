# Cohort-rule change + 43-44 retrain — EVENT PRE-REGISTRATION

**2026-07-23. Written for Fable's approval BEFORE Sunday's execution. No code path activates and no
fit runs until this is approved. The event itself is Sunday-timed (2044 data lands first).**

This is the atomic event the cohort arbitration recommended and Fable directed (option (ii),
2026-07-23): the cohort **selection rule** changes to a model-independent, data-fixed coordinate, a
fresh 43-44 model trains under it, and both pitcher ramps refit on the new coordinate — all as ONE
dated event. FIELD_N = 50 is RETAINED; the size was never the lever (arbitration Q1). The RULE is.

---

## 1. WHY (the arbitration verdict, one paragraph)

The task-0 STOP was a cross-model drift of 100% train-leg origin: the model-selected top-FIELD_N
cohort moved when the retrain's env-free selection reshuffled the wOBA ranking, so `trainingMeans`
moved −1.59 on hit.kRat, the K gap shrank ~1.6 at every tier, and the convex K ramp under-corrected
(Bronze Quick G1-K 0.99 → 1.06, CI-clear core FAIL). The cohort is **model-dependent**, so every
retrain — and, by the same-construction argument, every FORM change — reshuffles it. A **model-free**
selection metric makes the cohort a function of the **catalog ratings alone**, which are fixed across
retrains and form changes, so the gap coordinate becomes **data-fixed**: immune to both by
construction. That removes the arbitration's criterion-(a) feedback AND criterion-(b) cross-model
drift at the source, not by a tuning knob.

---

## 2. THE RULE (hard constraints, pinned — Fable, 2026-07-23)

The cohort (both legs, see §3) is the **top-FIELD_N cards by a MODEL-FREE metric over the WHOLE
rating vector**, replacing the current top-N-by-model-predicted-wOBA.

**HARD CONSTRAINTS on the metric (any violation is off-spec):**
1. **MODEL-FREE** — no `eventForm`, no `cardSideWobas`, no predicted wOBA of any kind enters the
   ranking. The metric reads only the card's ratings and catalog-fixed reference moments.
2. **WHOLE RATING VECTOR** — every rating channel the role uses, not one. Ranking on a single channel
   (the failure the current single-wOBA scalar approximates) is forbidden; the point is that no one
   channel — least of all a model-derived summary — drives membership.
3. **SAME METRIC BOTH LEGS** — the identical formula selects the train-leg cohort (in the trainer,
   over the training population) and the pool-leg cohort (in `computeUnifiedFieldStats`, over the
   tournament pool). The same-construction invariant is the whole point: the two legs of the gap must
   be built the same way or the gap has a systematic bias (the arm-B lesson).

**THE CANDIDATE METRIC — Z-SUM (to be confirmed in review):**

    zsum(card, role) = Σ over the role's rating channels of  (rating_ch − μ_ch) / σ_ch

where `μ_ch, σ_ch` are the **catalog-fixed** per-channel rating moments (computed once from the full
eligible catalog, role-appropriate, side-pooled), so the metric is data-fixed given a catalog. Higher
z-sum = stronger card; the top-FIELD_N by z-sum is the cohort. Rating channels: `HIT_RATINGS`
(eye/pow/kRat/babip/gap) for hitters, `PIT_RATINGS` (con/stu/pbabip/hrr) for pitchers — the same
channels the field means are taken over, so the selector and the selected are the same vector.

**Two review decisions, flagged, not pre-decided:**
- **Reference moments** — catalog-fixed (recommended: immune to pool composition, truly data-fixed)
  vs pool-relative (each leg z-scores against its own population). Catalog-fixed is the stronger
  same-construction invariant; pool-relative reintroduces a population dependence. Recommendation:
  catalog-fixed, one reference for both legs.
- **Channel weighting** — equal (plain z-sum) vs weighted. Equal is the minimal, assumption-free
  default and is the pinned candidate; any weighting would need its own justification and would risk
  smuggling a model back in.

---

## 3. BOTH LEGS, and why (Fable's sharpening)

The gap is `trainingMeans − poolField` per crossed channel. Today the POOL leg is stable across the
two artifacts ONLY because the eventForm is shared; a form change would drift it next. So **both legs
move to the model-free metric** — the train leg (frozen into `trainingMeans` at train time, in the
trainer) and the pool leg (`computeUnifiedFieldStats`, at scoring time). Same metric, same reference,
both legs. Then the gap is a function of (catalog, pool composition) ONLY — data-fixed — and moves
only on a REAL pool change, never on a retrain or a form change.

---

## 4. THE EVENT SEQUENCE (Sunday; one atomic event)

1. **2044 data lands** (Derek).
2. **New cohort rule in code** — the z-sum metric wired into both legs (built now, §6; activated in
   this step).
3. **Train the 43-44 model** under the new rule (its `trainingMeans` built by the new train-leg
   metric). A rule change re-trains by construction — this supersedes "League 42-43 Retrain", which
   is retired unused (it was zero-predictive-content over the active artifact anyway).
4. **K-ramp refit** on the new coordinate (its own re-derivation; the C3 prereg battery, §5). The
   drift-tax note dissolves under a data-fixed coordinate — gaps move only on real pool change — so
   **form freedom returns to the K refit** (the convex q that resolved diamond is not penalised).
5. **HR-ramp refit** on the new coordinate — the HR gap (H.pow↔P.hrr) moves with the new selection,
   so `PIT_SPREAD_HR` is re-derived too, same battery. The hitter-tail published residual
   re-measures on the new coordinate (it is not refit — still the deferred workstream).
6. **Full gates** (C6 over the coherent set) **+ the (c) validation report** (§7) **+ Scorecard v2**.
7. **Activation** on pass; one Derek Regenerate lands the new model + rules + refit ramps together.

Active stays `league-42-43` until step 7. Nothing here changes production before Sunday.

---

## 5. THE RAMP REFITS — the C3 battery, unchanged, on the new coordinate

Both pitcher-ramp refits use the pre-registered C3 machinery verbatim: the free-slope-with-per-tier-
level estimand (ruling z), deliverable-space equivalence selection with a minimax centre (ruling x),
the identifiability / (w)2' applied-domain / leave-one-tier-out gates, the monotone-feasibility
coherent-set rule with the smallest-gap-tier-mandatory bar, the domain flat-hold, and stamped +
asserted provenance. `fitN = 50`, `fitP = 0.30` unchanged. Nothing about the ramp *method* changes —
only the coordinate it is fit on.

---

## 6. PROVENANCE — the selection RULE joins the stamp

The gap is now data-fixed, so the ramps are retrain-stable BY CONSTRUCTION — but the selection rule
is a **coordinate-defining choice**, so it is stamped and asserted like `fitN`/`fitP`. A future change
to the selection metric moves the coordinate exactly as a cohort-size change would, so
`assertKSpreadProvenance` gains a **selection-rule tag** (a short identifier of the metric, e.g.
`"zsum-catalog-v1"`); a ramp fit under one rule and scored under another throws, same as the (N, p)
mismatch. This closes the exact hole the STOP walked through — a coordinate move that the ramp did not
know about.

---

## 7. THE (c) VALIDATION REPORT (in-event, NOT a pre-build, NOT a gate — Fable)

The event reports **both rules' correlation with realized opposition** (the model-selected cohort vs
the z-sum cohort, each correlated against the realized opposition strength from the capture corpus per
format). It is a REPORT, not a gate: the failure mode criterion (c) guards — a cohort that does not
represent the field a card actually faces — is already caught by the (w)1 identifiability and the
acceptance gates on the new coordinate (a non-representative cohort produces a mis-ordered or
mis-levelled gap that those gates reject). The report exists so the trade the rule makes
(drift-stability for whatever predictive edge model-selection had, if any) is measured and on the
record, not assumed.

---

## 8. WHAT IS NOT IN THIS EVENT

- The **hitter-tail refit** — still the deferred workstream behind task 2; here it only re-measures
  as a published residual on the new coordinate.
- The **anchor-uniformity audit** and the **composition-layer (task-2) prereg** — queued behind this
  event, as before.
- Any **FIELD_N** change — 50 is retained; the arbitration settled that size is not the lever.

(end of pre-registration — cohort-rule change + 43-44 retrain)
