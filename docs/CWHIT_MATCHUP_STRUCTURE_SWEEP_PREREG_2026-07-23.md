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
> concentrated on vR (against RHB), with a reported +0.54/600 hand-split LEVEL gap — a curve-form
> defect, not a pure frame effect.
>
> **CORRECTION 2026-07-25** (`tools/kresidual-hand-power.ts`, artifact
> `fixtures/kresidual-hand-power-2026-07-25.txt`): **the +0.54/600 hand LEVEL gap is NOT SUPPORTED** —
> CI [−1.34, +2.59], p = 0.586, well inside its own noise. Amendment 1 §A treated the hand-split LEVEL
> read as load-bearing ("confirmed"); it is not, and that claim is withdrawn. Only the CUBIC SHAPE
> asymmetry has support, and even that is a boundary case: the direct vR−vL cubic difference is
> −0.868, CI [−1.966, −0.010], p = 0.049, and the CI covered zero under a different RNG stream.
> What IS solid: the POOLED cubic (−0.5049, CI-clear) is unaffected by any of this, and the
> vR-concentration is NOT a power artifact — vL is thinner in raw BF (78%) but BETTER informed about
> the cubic contrast (ESS 11.6 vs 9.6; CI 21% narrower), so "vL is flat" is a resolved reading, and
> vR's cubic survives BF-matching to vL (negative in 100% of draws, CI-clear in 85.8%).
> Amendment 1 §A's expansion of the MEASUREMENT to both hands stands unchanged — this correction is to
> the pre-step's level claim, not to the sweep's scope. It is also the first live application of
> Amendment 2 RULE M3 (power reported with every null). Its DIRECTION at high Stuff is OVER-prediction of K (opposite the naive "too-
> shallow" hypothesis), which unwinds the single-mechanism unification with the anchor audit's wOBAA
> bias. Full reading is in the pre-step handback; it is the reason K is in the measurement (A) but its
> coordinate is deferred (B).

(end of AMENDMENT 1 — matchup-structure sweep)

---

# AMENDMENT 2 — measurement-layer gates. 2026-07-25. Written under the collapsed role (Opus 5 owns authority + execution).

**Status: this amendment RE-CONFIRMS the amended sweep and is the condition under which it may run.**
Amendment 1 expanded the MEASUREMENT to all channels × both roles × both hands × the format registry —
roughly 500 cells — while §4's gates were written for the P0–P3 predictor ladder only. The largest
measurement surface in the program's history was therefore ungated. That is the hole this closes.

Nothing here narrows Amendment 1's scope. It constrains what the measurement is ALLOWED TO
AUTHORISE.

---

## 2.1 THE MEASUREMENT LAYER IS EXPLORATORY. Declared, not discovered.

At ~500 cells, a 95% CI screen produces roughly 25 spurious "CI-clear" cells by chance alone, and
"CI-clear hand-split on channel X" is precisely the evidence format this program acts on. Therefore:

**RULE M1 — NO SWEEP CELL ALONE MAY AUTHORISE A FIT.** A channel earns a correction only after the
effect CONFIRMS on formats that were not used to surface it. Selection formats and confirmation
formats are drawn from the registry by `tournamentId` (never a slug list — the b4dc2ed rule) and the
split is declared BEFORE the sweep runs, not after.

**RULE M2 — the sweep reports EFFECT SIZES, not verdicts.** Every cell reports its point estimate,
its CI, and its BF/PA support. Cells are ranked by effect size in deliverable terms (per-600 and
per-card wOBA), never by p-value or CI-clearance. A cell that is CI-clear but deliverably tiny is
reported as tiny.

**RULE M3 — POWER IS REPORTED WITH EVERY NULL.** A flat cell is only evidence of absence if it had
the power to see the effect. Every null carries its CI width and the minimum effect it could have
resolved. "Covers zero" is not a finding on its own. (This rule is written by the vR/vL K result,
where the hand asymmetry may be power rather than signal — under test separately in
`tools/kresidual-hand-power.ts`.)

**RULE M4 — the multiplicity is stated in the artifact.** The artifact's header carries the total cell
count and the number of CI-clear cells expected by chance at that count, so no reader — including me —
can treat the raw count of "significant" cells as a finding.

## 2.2 PER-CHANNEL CLOSE RULES. What a null looks like, declared in advance.

Each channel must be able to CLOSE. A measurement plan with no exit will always find one more thing.

- **BB-class (`pit.con ↔ hit.eye`)** — no correction exists anywhere in the model, so the sweep is the
  only instrument that can say one is MISSING. **CLOSE CONDITION: if the realized field tracks its
  rating cohort within the confirmation band, BB is declared to need no correction and the channel is
  CLOSED — not re-opened without new evidence of a different kind.** Prior evidence favours closure:
  the anchor-uniformity audit (`fixtures/anchor-uniformity-audit-2026-07-23.txt`) found BOTH BB
  channels UNIFORM (pit BB9 slope covers 0; hit BB% same), i.e. level-only and anchor-absorbed, which
  does not distort card ordering.
- **K-class (`pit.stu ↔ hit.kRat`)** — measured here, but its coordinate stays deferred (Amendment 1 §B).
  The in-frame curve defect is fixed FIRST (own prereg, own gates, out-of-time validated); only the
  need REMAINING after the curve fix is attributable to matchup structure. **CLOSE CONDITION: if the
  post-curve-fix residual need is within the confirmation band, K's matchup coordinate is closed.**
- **HR/BABIP-class (`pit.hrr`, `pit.pbabip`, `hit.pow`, `hit.babip`)** — carries the ladder (§2.3).
  **CLOSE CONDITION: if no ex-ante predictor beats P0 in deliverable terms, the current coordinate is
  KEPT, the confounding is documented as a known limitation, and the coordinate question is closed as
  answered-in-the-negative.** This is an acceptable, non-failure ending and is pre-committed as such.
- **Remaining channels (`hit.gap`, and any not carrying a correction)** — measured for completeness;
  a finding here opens a NEW pre-registered item, it does not extend this one.

## 2.3 THE PREDICTOR LADDER — P1 AND P3 REINSTATED. Ruling recorded as a ruling.

**I proposed cutting P1 (whole-pool mean) and P3 (percentile-band) on the argument that, because the
optimizer's objective is beating the BEST rosters, a predictor describing the typical opponent is
"the wrong target by construction — no measurement needed." THAT ARGUMENT IS WITHDRAWN.** It conflates
two layers I had myself separated one step earlier:

- the OPTIMIZER'S OBJECTIVE = which rosters we want to beat (the best);
- the CALIBRATION COORDINATE = which opposition GENERATED the observed outcomes we fit against.

The coordinate's job is the second. What we wish to beat does not change what the observed numbers
were accumulated against. The (c) report (`fixtures/cohort-channel-groundtruth-2026-07-23.txt`)
measured that ground truth directly — realized field 10–17 (kRat) / 9–13 (pow) below EVERY top-N
cohort, realized-usage weighting best in 38 of 45 cells — and P1/P3 are the two candidates shaped like
that finding. They may well lose (P1's flat average is the most likely to fail the identifiability
gate), but **they must lose by MEASUREMENT.** The whole ladder runs through one harness, so the
marginal cost of carrying them is near zero, and "no measurement needed" is the sentence that preceded
three prior coordinate failures in this program's record (the arm-C inversion, the z-sum coordinate,
the live-pool result).

**RULING: P0, P1, P2, P3 all run, on the HR/BABIP-class as scoped in Amendment 1 §B.** Rejected
alternative: cut P1/P3 by argument (rejected — deciding by construction what the data was prepared to
decide by measurement). Rejected alternative: cut the whole ladder (rejected — it discards the layer
improvement along with the foundation-digging; the ladder is scoped, cheap, and gated).

**Note on P2 (playability-weighted).** Who plays is driven by availability AND ratings AND
eligibility (Derek, 2026-07-25). Ratings and eligibility are catalog-derived and legal; availability
is game economy and is BANNED from modelling ([[never-flag-config-edits-or-meta-economy]]) — it is
neither an input nor an argument here. So P2 is expected to capture the ratings/eligibility part and
to MISS the availability part; it is measured on that understanding, and gate 3 (§4, no market/usage
leak) is unchanged and binding. P2's most defensible benefit may be STABILITY rather than accuracy —
it replaces top-N's hard membership edge (measured churn: only 26–38 of 50 members shared under an
alternative rule) with a smooth weighting. If P2 wins, the artifact must state whether it won on
tracking or on stability, because those imply different things downstream.

## 2.4 INTERPRETATION RULES for the realized-field ground truth.

**SURVIVORSHIP (Derek, 2026-07-25).** Better teams play MORE games in a tournament because losing
teams are eliminated, so any usage-weighted measurement over this corpus is already tilted toward what
the STRONG teams played. Two consequences the artifact must carry:
1. The measured cohort−realized gap is a LOWER BOUND — the realized field sits below the top-N cohort
   even after survivorship pushes it upward.
2. The objective and the calibration data do not conflict: the corpus over-represents strong
   opposition by construction, so the opposition we calibrate against is already close to the
   opposition we care about beating.
Also: a playability prior fit on realized usage is partly fitting WINNING, not only quality —
state that where P2 is interpreted.

**ROUND-POOLING IS SELF-CONSISTENT — NOT a limitation.** cwhitstats pools all rounds of a format. A
card's observed stats and the opposition inside those stats come from the SAME games, so both sides
are weighted by run depth identically. Nothing needs correcting for it. (Recorded because I initially
wrote this up as a defect; it is not one.)

**OPEN, UNQUANTIFIED — within-format heterogeneity.** The tilt is not uniform across cards inside a
format: a card whose team ran deep faced tougher opposition than one eliminated early, and run depth
correlates with card quality. If real, this COMPRESSES the observed good-vs-bad gap — the exact
quantity the spread ramps are fit to. Not measurable without round-level rows (the corpus has none).
NOT being chased; recorded so it is known to sit inside any spread refit.

## 2.5 DATA. Measurement now; fits wait.

The current capture corpus is adequate for MEASUREMENT and the sweep runs on it now. **No composition-
layer FIT may use it.** Fits wait on the wide re-pull, which extends the window backward (depth, and
several cells are thin) and, pulled today, also picks up everything after the corpus's ~2026-07-19
cutoff as a forward slice. It is the only temporal replication this program has ever had available —
partial, because the older pool is genuinely weaker (cards improve every window, so an old-vs-new
split cannot cleanly separate measurement noise from real drift), but unique. Derek's action; it gates
§2.3's fits and every composition-layer fit behind them.

## 2.6 STANDING DISCIPLINES restated (they are now the only integrity control).

- **Prereg before fit.** A gate decided after seeing a result is not a gate.
- **Independent refuter** on any prereg that authorises a fit; its refutation is appended to the doc.
- **Deliverable-space selection**; publish the equivalence set; a selection at a grid edge is family
  misfit, not a fit.
- **Clause 4 / atomic event.** A coordinate change and every correction consuming it ship together.
- **Residual ledger must SHRINK.** Six published residuals stand. Success bar for the composition
  layer, adopted and on the record: **at least four of the six retired.** A SEVENTH requires an
  explicit STOP stating why six did not already mean stop.

(end of AMENDMENT 2 — matchup-structure sweep)
