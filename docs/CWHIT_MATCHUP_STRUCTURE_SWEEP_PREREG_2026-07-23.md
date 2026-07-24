# Matchup-structure sweep — PRE-REGISTRATION (composition layer, HR/BABIP-class family)

**2026-07-23. Written for Fable's approval BEFORE any fitting. This is a MEASUREMENT + selection
design; no coordinate is fit and nothing wires until this is approved. Production stays league-42-43 /
model-woba (guarded) throughout.**

The composition layer opens here. The cohort-event STOP and the generalized (c) report established
that a single-cohort single-channel-mean coordinate cannot satisfy the four constraints at once, and
that the realized field a card faces is NOT a rating-cohort proxy — rating cohorts over-estimate the
realized opposition systematically (+9..+13 on pow, +10..+17 on kRat). This sweep is the composition
layer's first phase for the **opposition-responsive family (HR/BABIP-class)**: measure the STRUCTURE of
that over-estimation across formats, and select the EX-ANTE predictor of the realized field that
captures it. The K-class is out of scope here (pitcher-side per the battery; its curve-form pre-step
runs separately and re-scopes the K coordinate question).

---

## 1. THE FOUR CONSTRAINTS (Fable, the coordinate-design spec written by three failures)

Any coordinate the composition layer ships must be:
1. **DATA-FIXED** — a function of the catalog + format, immune to retrains and form changes (the
   cohort-event lesson).
2. **PER-CHANNEL IDENTIFIABLE** — each channel's coordinate orders its tiers/formats the way the
   realized channel does (the (w)1 lesson: whole-vector selection broke kRat's ordering).
3. **SHAPE-AWARE** — respects that channels differ in how they relate to value/composition (the
   rating-shape doctrine: pow tracks value, kRat does not).
4. **EX-ANTE** — computable before a tournament is played, from ratings / eligibility / format rules.
   Realized usage is NOT ex-ante and cannot be the coordinate (the (c) report: realized-usage tracks
   best but is unusable as a predictor).

The (c) report proved no single-cohort single-channel-mean satisfies all four. This sweep searches the
next class: **ex-ante predictors OF the realized field**, per channel.

---

## 2. THE GROUND TRUTH AND THE TARGET (unchanged from the (c) report)

The GROUND TRUTH per format × channel is the usage-weighted realized opposing-channel mean over cards
actually played (captures; Rec.sample = opponents faced). The TARGET a predictor must hit is that
realized mean — and, more importantly for a coordinate, its ORDERING and SHAPE across formats. The (c)
report is data point one; this sweep extends it across the full corpus and to the candidate predictors
below.

Scope: the **HR/BABIP-class channels only** — the opposition-responsive ones (battery verdict). For
pitchers facing hitters that is `hit.pow` (→ HR) and `hit.babip` (→ BABIP); the reciprocal hitter-
facing pitcher channels (`pit.hrr`, `pit.pbabip`) are included so both roles' HR/BABIP coordinates are
designed together. `hit.kRat ↔ pit.stu` (the K-class) is EXCLUDED — pitcher-side, pre-step first.

---

## 3. THE CANDIDATE EX-ANTE PREDICTORS (what the sweep selects among)

Each is a function of the ELIGIBLE POOL (catalog + format rules) ONLY — no realized usage, no market
behaviour (banned). Ranked from simplest; the sweep measures each against the realized truth.

- **P0 — top-N cohort mean** (the baseline the (c) report already measured): model-woba and
  zsum-catalog. Carried as the null to beat; the (c) report shows both over-estimate.
- **P1 — full-pool channel mean** (no selection): the eligible pool's whole-population channel mean.
  Tests whether the over-estimation is purely a top-N SELECTION artifact (if the full pool matches the
  realized field, the field is "the average eligible card", not "the top-50").
- **P2 — playability-weighted pool mean**: the eligible pool weighted by an EX-ANTE playability prior
  — a function of ratings/value/eligibility that predicts how much a card is played, fit ONCE as a
  universal (format-property) function, never per-format. This is the (c) report's finding-2 gap made
  into a model: the realized field is the eligible pool re-weighted toward what actually gets played,
  and if that re-weighting is predictable from ratings it is ex-ante.
- **P3 — percentile-band field model**: the realized field modelled as a fixed rating-percentile band
  of the eligible pool (e.g. the p40–p90 mean rather than the top-N), the band being a universal
  format-property parameter. Tests whether "the field is a middle slice, not the top" captures it.

The winning predictor is the one that best tracks the realized field's LEVEL and ORDERING across
formats, per channel, out-of-format. If no ex-ante predictor beats P0's baseline meaningfully, that is
itself the finding (the matchup structure is not ex-ante-predictable from ratings alone, and the
composition layer needs a different input — reported, not forced).

---

## 4. THE SWEEP (measurement) AND THE SELECTION

**Measurement, per format × channel (full corpus, stratified A/B/C):**
- the realized-field mean (ground truth) + its cross-format ordering;
- each predictor P0–P3's mean, as a BIAS vs truth, and its cross-format ordering-agreement;
- the realized-usage cohort as the bridge (isolates top-N truncation from selection error), exactly as
  the (c) report.

**Selection (deliverable-space, the program's standing rule):** predictors are equivalent iff their
implied field means differ by less than the realized-field SE at every format; the recommended
predictor is the simplest one whose bias and ordering are within that band across the corpus. A
predictor selected at a family/grid edge, or one that only wins in-sample, is rejected.

**Gates (pre-committed):**
1. **OUT-OF-FORMAT** — the predictor is selected on a subset and validated on held-out formats
   (formats from the registry by tournamentId, never a slug list — the b4dc2ed rule). A predictor that
   does not generalize across formats is not universal.
2. **PER-CHANNEL IDENTIFIABILITY** — the predictor's cross-format ordering must match the realized
   channel's, per channel (the (w)1 analogue at the format level).
3. **NO MARKET/USAGE LEAK** — the ex-ante predictor reads only ratings / eligibility / format
   structure; a source scan pins that no realized-usage or price/market quantity enters it.
4. **DATA-FIXED** — the predictor is a function of (catalog, format) only; re-running it under a
   different model artifact returns the identical coordinate (the cohort-event invariant).

Any gate failing ⇒ STOP and report; overrules are Fable's or Derek's.

---

## 5. WHAT THIS SWEEP DOES NOT DO

- It does NOT fit the ramps or wire a coordinate. It selects the predictor STRUCTURE; the coordinate
  build + ramp refits are a later, separately-pre-registered step under the settled predictor.
- It does NOT touch the K-class. That is pitcher-side; its curve-form pre-step
  (`tools/kresidual-stuff-inframe.ts`) runs in parallel and, if it confirms a curve-form defect,
  re-scopes the K coordinate question to "fix the curve, then re-measure the remaining need".
- It does NOT change production. league-42-43 / model-woba stays active and guarded.

---

## 6. WHY THIS ORDERING (measure the structure before designing the coordinate)

The three failures that wrote the four constraints all came from designing a coordinate on an
assumed structure (model-woba's kRat ordering was a coincidence; z-sum's whole-vector broke it;
channel-specific is 0/45). This sweep measures the realized structure FIRST, across the corpus, so the
coordinate is designed against what the field actually is — not against another lucky proxy. The (c)
report is data point one; this generalizes it into the empirical basis the coordinate design will be
pre-registered against.

(end of pre-registration — matchup-structure sweep, as originally drafted)

---

# AMENDMENT 1 — Fable's scope expansion. 2026-07-23. CONDITIONAL APPROVAL — returns for re-confirmation before any measurement.

Fable approved the design with ONE required scope change, plus one targeted check riding the sweep.
Nothing is measured until this amended prereg is re-confirmed. It separates cleanly into two layers —
the change is that the MEASUREMENT layer expands to everything, while the coordinate-PREDICTOR layer
(P0–P3 + its gates) stays scoped exactly as §3–§4 drafted them.

### A. MEASUREMENT SCOPE expands to ALL channels × BOTH roles × BOTH hands.

The realized-field structure (§2 ground truth: usage-weighted realized opposing-channel mean, its
ordering and shape across formats) is measured for **every channel, both roles, and BOTH hand-splits**:

- **pitcher-facing-hitter channels:** `pit.stu`, `pit.con`, `pit.pbabip`, `pit.hrr`, each split by the
  HITTER hand faced (vL / vR).
- **hitter-facing-pitcher channels:** `hit.eye`, `hit.kRat`, `hit.pow`, `hit.babip`, `hit.gap`, each
  split by the PITCHER hand faced (vL / vR).

Two channels that §2–§3 excluded are now IN the measurement:

- **K-class (`pit.stu ↔ hit.kRat`) is INCLUDED.** The pitcher-side battery verdict cleared pooled-
  opposition SPREAD effects — it never cleared hand-split LEVEL effects, which are exactly what a
  matchup sweep can see. The curve-form pre-step (below, and now COMPLETE — see the note) confirmed an
  in-frame hand-asymmetric K misfit, so the sweep must carry K to separate its curve-form part from any
  remaining realized-field (matchup) part.
- **BB-class (`pit.con ↔ hit.eye`) is INCLUDED.** No BB correction exists anywhere in the model. The
  sweep is the ONLY instrument that can say whether one is MISSING — a null (BB's realized field tracks
  its rating cohort) is as informative as a positive, and either way BB cannot be answered without
  being measured.

### B. COORDINATE-PREDICTOR LADDER (P0–P3) + its gates stay scoped to the HR/BABIP-class ONLY.

The §3 predictor ladder and §4 gates are the machinery for BUILDING a coordinate, and a coordinate is
needed only by a channel that will CARRY a correction. So the ladder still runs only for the
opposition-responsive HR/BABIP-class (`pit.hrr`, `pit.pbabip`, `hit.pow`, `hit.babip`):

- **K's coordinate waits on the curve-form pre-step outcome** — if the K residual is a fittable curve
  defect (it is, in-frame; see the note), the K fix is a CURVE-family proposal, not a matchup
  coordinate, and its remaining matchup need is re-measured only AFTER the curve is fixed.
- **BB gets a coordinate only if the measurement finds a missing correction** — the ladder is
  conditional on the measurement's BB verdict, not run pre-emptively.

So: measure everything (A); build predictors only where a correction lives (B). The four constraints,
the deliverable-space selection, and the four gates (§4) are unchanged for the channels the ladder runs
on.

### C. TARGETED CHECK riding the sweep — bronze high-pBABIP pitcher cohort (Derek's field report).

Independent confirmation of the held BUILD-3 defect. The held pitcher-BABIP leg needs **bronze ≈ 1.48
vs silver/gold ≈ 1.0** — a large bronze-specific correction that was measured and then HELD (never
shipped). That held leg PREDICTS exactly the undervaluation Derek reports on bronze rosters: without
the ~1.48 bronze scalar, high-pBABIP pitchers on bronze are scored as if their contact suppression
counts at the silver/gold rate, so they come out undervalued. The check:

- take the bronze high-`pit.pbabip` pitcher cohort, compute the deployed model's residual vs the cwhit
  ACTUALS on that cohort, and QUANTIFY the undervaluation (per-600 wOBAA and rank terms);
- confirm (or refute) that its size matches the held ~1.48 leg's implied correction.

On Fable's ruling, **pitcher-BABIP heterogeneity is ELEVATED from watch to an ACTIVE composition-layer
item** on Derek's evidence. This check is the sweep's first concrete composition-layer deliverable.

### D. SEQUENCE — unchanged.

Curve-form pre-step (K residuals vs Stuff on league data) **and** the amended sweep run in PARALLEL.
Nothing fits until this amended prereg is re-confirmed. Production stays league-42-43 / model-woba
(guarded) throughout.

> **NOTE — the curve-form pre-step is COMPLETE** (`tools/kresidual-stuff-inframe.ts`, artifact
> `fixtures/kresidual-stuff-inframe-2026-07-23.txt`). It found a CI-clear in-frame cubic K misfit
> concentrated on vR (against RHB), with a +0.54/600 hand-split LEVEL gap — a curve-form defect, not a
> pure frame effect. Its DIRECTION at high Stuff is OVER-prediction of K (opposite the naive "too-
> shallow" hypothesis), which unwinds the single-mechanism unification with the anchor audit's wOBAA
> bias. Full reading is in the pre-step handback; it is the reason K is in the measurement (A) but its
> coordinate is deferred (B).

(end of AMENDMENT 1 — matchup-structure sweep)
