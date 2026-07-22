# C3 — the re-derived K ramp. PRE-REGISTRATION.

**2026-07-22. Written BEFORE any fitting, for Fable's approval. No fit runs until this is approved.**

C1 and C2' have shipped, so the coordinate this ramp is fitted on is final. Everything below is fixed
in advance: the family, the pinning rule, the identifiability gate with its numbers, the acceptance
criteria, and the kill conditions. Nothing here is a result.

---

## 1. What is being fitted, and what is NOT

**Fitted:** one monotone-in-gap function `s(g)` giving the pitcher K-spread scalar, from per-card
noise-weighted residuals, with **no per-tier freedom**.

**Not fitted, and not up for revision here:** the coordinate `g` (fixed by C1 + C2'), the presence
prior `p = 0.30` (ruling (t)), the cohort size `FIELD_N = 50` (known-defective, frozen until a retrain,
protected in the interim by internal consistency), the eligibility predicate, or anything hitter-side.

**The freeze applies.** Mid-fit discoveries are RECORDED, not acted on, unless they are STOP-class
instrument defects.

---

## 2. The coordinate, as it now stands

Measured on the shipped post-C1/C2' path:

    gap pit.stu        iron    bronze    silver     gold   diamond
    p = 0             24.78     23.95     20.51    18.81     13.07
    p = 0.30          22.25     19.69     17.53    15.02     10.31

The needs are the measured per-tier calibration slopes at BF>=600 (primary) and BF>=1000
(sensitivity), RE-MEASURED on this coordinate as part of the fit rather than carried over.

---

## 3. The family, and the G-pinning rule on the new axis

**Family:** the minimal CONVEX-CAPABLE monotone form in `g`, with `s(g <= 0) = 1` exactly.
Convex-capable is required because the coherent tiers' needs are convex in gap and the saturating
family was falsified for being unable to bend that way. Monotone is required because a non-monotone
`s(g)` would reorder tiers relative to one another on the very axis the ramp is fit along.

**THE G-PINNING RULE, stated before the fit because the axis has moved.** `G` was only ever
LOWER-bounded — SSE flat within 5% of the linear limit across a wide `G` range — which is why a pinning
rule exists at all. C2' shifts the whole axis DOWN by 2-4 gap points while the coherent-four span
holds, so identifiability is not automatically preserved and must be tested, not assumed.

Rule, unchanged in form from BUILD-1 so the two fits stay comparable: **the most-saturating `G` whose
SSE is within 5% of the linear-limit SSE**, reported together with the identifiability band and the
linear-limit figure. Comparisons across fits are made on **beta over the observed gap range, never on
raw {A, G}** — those are two pinning outcomes, and comparing them compares the rule, not the fits.

---

## 4. The identifiability gate (ruling (w)) — three prongs, with numbers

**Prong 1 — the axis still carries the information. ALREADY MEASURED, PASSES.**

    ordering strictly descending          p=0 ok   p=0.25 ok   p=0.30 ok   p=0.35 ok
    coherent-four span retention vs p=0            87.4%       102.0%      87.4%

Requirement: ordering at the fitted `p` matches p=0's, AND coherent-four span retention >= 60%.
Measured 102.0% at the shipped p=0.30 and >=87% at both sensitivity points — clears with margin
everywhere in the band. Recorded now so the gate cannot be re-read after the fit is seen.

**Prong 2 — boundary-pinned optimum = family misfit.** Standing rule, restated: if `A` or `G` lands on
a grid edge the family is wrong and the result is unshippable. A STOP, not a tuning signal.

**Prong 3 — leave-one-tier-out stability.** Refit five times, each dropping one tier. Every form
parameter from every refit must lie inside the full fit's bootstrap CI. A parameter escaping means one
tier is determining the form — per-tier freedom arriving by the back door.

**Any prong failing => STOP and report. Overrules are not mine.**

---

## 5. Acceptance criteria

1. **DIAMOND WITHIN CI.** Ruling (u) makes diamond C3's to own: it was always one of the coherent four
   ((gap 10.31, need ~1.04) sits on the convex curve), and its standing G1 failure is the falsified
   saturating family over-correcting at low gap. A miss is a **STOP-class surprise**, not a tolerable
   residual.
2. **GOLD'S MISFIT RECORDED OPENLY**, with the five-card provenance travelling with the constant:
   Radke, Randy Jones, Hilton Smith, Barnes, Quisenberry — 31.5% of gold's predicted-K variance on 5.5%
   of its cards, all below the league training p05, all striking out 1.4-3.1 fewer per nine than
   predicted. Gold is FITTED, not excluded; its residual is published rather than absorbed.
3. **GATES RE-CHECKED AT p = 0.25 AND 0.35.** Holding across the band retires p's uncertainty; failing
   across the band is the ONLY evidence that reopens property-conditioning.
4. **BUDGET-FORMAT HELD-OUT VALIDATION** on bronze-cap-weekly, gold-slots and gold-cap — validated,
   never fitted. Budget formats force weak cards into play, which is exactly where the weak-card K
   over-prediction bites. **Two of the three were unreachable through the builder until `b4dc2ed`**
   (`legacySlug` is optional and capture paths resolved by it alone), so this leg exists only because
   that was fixed — and the fit must confirm it is reading real data in all three, not silently empty.
5. **PROVENANCE STAMPED, WITH SCORING-SIDE ASSERTIONS:** `fit-N = 50` and `fit-p = 0.30` recorded on
   the constants and asserted at scoring time against the values actually in force. A ramp fitted at
   one (N, p) and evaluated at another is meaningless, and since the gap is NOT monotone in `p` it can
   never be rescaled — only re-derived.
6. **A CAPTURE TRIPWIRE** ships with it: every re-pull recomputes realized conditional presence against
   `PRESENCE_P`. Inside 0.25-0.35 => no action; outside => a p-update flagged for the next refit event,
   retrain-coupled like FIELD_N.

---

## 6. Kill conditions

1. Any identifiability prong fails.
2. Diamond outside CI — STOP-class.
3. A boundary-pinned optimum anywhere.
4. Leave-one-out instability.
5. A fitted form non-monotone over the observed gap range.
6. Gates holding at p=0.30 but failing at BOTH 0.25 and 0.35 — that reopens conditioning, which is a
   ruling and not a fit decision.

A partial pass stays a partial pass. The pattern of what holds and what does not is the deliverable,
and the verdict returns to Fable before anything ships.

(end of pre-registration — C3)

---

# AMENDMENT 1 — Fable's approval clarifications. 2026-07-22.

Appended before the fit. Where this conflicts with §4–§5 above, this governs.

## A1.1 The acceptance bar, stated explicitly

**GATE (600-bar needs):** the implied per-tier slope lies inside the measured bootstrap CI for
**at least 4 of the 5 tiers, and DIAMOND MUST BE ONE OF THEM.** A diamond miss is **STOP-class** and
is not tradeable against the other four — ruling (u) makes diamond C3's to own, because it was always
one of the coherent four and its standing G1 failure is the falsified saturating family
over-correcting at low gap.

**THE 1000-BAR IS A SENSITIVITY REPORT, NOT A GATE.** This is a structural point, not a leniency: a
POOL-LEVEL ramp is one function `s(g)` of a format's gap, so it returns the same scalar whatever
usage floor the evaluation set is drawn at. It CANNOT move between bars, and demanding that it
reproduce a bar differential would be demanding the impossible — the same reason centerpiece #2's P3
was decisive there and is inapplicable here. Gold's 1.78→1.63 bar differential therefore stays a
DIAGNOSTIC, attached to the five-card provenance, and is never scored as a pass or fail.

## A1.2 Why gold is fitted in, on its actual justification

Earlier framing said gold is "fitted, not excluded" and left the justification implicit. The real one
is technical: **the objective is per-card residuals weighted by per-card noise**, so gold's five
light-usage sub-p05 cards are downweighted by their own evidential mass — automatically, in
proportion to how little they are observed. That is the principled form of what excluding them
approximated by hand. Exclusion would have been a blunt instrument achieving the same end less
honestly, and would have discarded whatever real signal those cards do carry.

Their residual is still published rather than absorbed, and the five names travel with the constant.

## A1.3 Stratification (new standing structure, adopted)

All scoreboard and defect reporting from here stratifies three ways, and a defect attributes to the
stratum where it FIRST appears:

    A  neutral uncapped quicks       the core
    B  env-bearing uncapped dailies  + the era/park layer
    C  budget cap/slots formats      + the composition layer

One universal model, stratified diagnosis. C3's held-out budget validation is a stratum-C read and is
reported as such — a stratum-C miss does not impugn the core fit, it localises to the composition
layer, which is task 2's territory and is not built yet.

## A1.4 Record-keeping (permanent)

Modelling decisions in this document and its results carry TECHNICAL rationale. Derek's domain facts
are EVIDENCE, never verdicts. Past items recorded as "Derek decided" are revisable on evidence.

(end of amendment 1 — C3)

---

# AMENDMENT 2 — Fable's STOP rulings (z), (x), (y). 2026-07-22.

Appended AFTER the amendment-1 fit stopped and BEFORE the refit. Where this conflicts with §3–§6 or
amendment 1, **this governs**.

**The amendment-1 fit stands as the record of what the amendment-1 spec produced**:
`fixtures/cwhit-c3-ramp-fit-2026-07-22.txt`, generated by `tools/fit-kspread-c3.ts` at commit
`1804336` (recoverable with `git show 1804336:tools/fit-kspread-c3.ts`). The tool is amended IN PLACE
rather than forked: a second eight-hundred-line copy of the fit machinery is precisely the defect this
program keeps paying for, and git already holds the earlier version.

---

## A2.1 The estimand — ruling (z). THE OBJECTIVE GAINS A PER-TIER FREE LEVEL.

**What went wrong.** Amendment 1's objective scored `obs_i − [K̄_t + s(g_t)·(pred_i − K̄_t)]`. The judged
sample sits OFF `K̄_t` (weighted mean pred is 0.13–0.42 below it in every tier), so that residual
prices the sample's LEVEL offset as well as its SPREAD. Its minimiser is the pivot slope, which was
measured **+0.18 above the free slope in every tier, same sign** — systematic, not noise. Acceptance A
scores against the free slope. **The fit and the gate were estimating two different things**, which
violates the intent contract's third clause and is the whole reason for this amendment.

**The correction.** Level belongs to the anchor layer, not to `s`. The objective becomes

    obs_i = c_t + K̄_t + s(g_t)·(pred_i − K̄_t) + ε_i        c_t FREE per tier

Profiling `c_t` out at its weighted optimum leaves, exactly,

    residual_i = (obs_i − ō_t) − s(g_t)·(pred_i − p̄_t)

with `ō_t`, `p̄_t` the **noise-weighted within-tier means**. Writing `d_i = pred_i − p̄_t` and
`z_i = (obs_i − ō_t) − d_i` gives `residual_i = z_i − A·u_t·d_i`, `u_t = (g_t/G0)^q` — the same
three-sum reduction, `A` still closed-form at every `q`. **`K̄_t` drops out of the objective entirely**:
with a free level the pivot is unidentified, which is the correct statement of the ruling. `s` is now a
pure spread response and nothing else.

**The remaining difference between fit and gate is weighting only.** The fit's per-tier estimand is the
noise-weighted free slope; the need is the unweighted mmse free slope. Measured at amendment 1 those
differ by −0.01 to +0.07 per tier, every one inside the need's own CI half-width — against the pivot's
systematic +0.18. It is second-order, it is reported per tier, and it is not hidden.

**PRODUCTION IS UNCHANGED BY THIS.** Production still applies `s` about `K̄_pool`, because production
has no per-tier level to apply — the level lives in the anchor layer. What changes is what `s` is
*estimated to be*. The level consequence of applying a spread scalar about `K̄_pool` to a sample that
sits off `K̄_pool` is real, and it is PUBLISHED as a diagnostic rather than fitted away.

---

## A2.2 Selection — ruling (x). DELIVERABLE-SPACE EQUIVALENCE replaces the SSE band.

**The 5%-of-linear SSE band is retired.** It was calibrated against a TIER-AGGREGATE SSE, where 5% is a
meaningful slice; against a per-card SSE dominated by irreducible sampling noise it spanned
`q ∈ [0.05, 3.15]` and the "most-saturating member" tie-break ran to the grid edge. That is an
inherited rule surviving an objective change — contract clause 4 — and it is replaced, not patched.

**The new rule asks the only question that matters: can the acceptance instrument tell two candidates
apart?** The deliverable is `s(g)`, not `(A, q)`.

    candidates 1 and 2 are EQUIVALENT  ⟺  max over fitted tiers  |s₁(g_t) − s₂(g_t)| / se_t  ≤  1

where `se_t` is the per-tier NEED's standard error. The **EQUIVALENCE SET** is every grid candidate
equivalent to the SSE optimum, and it is **published in full** (its `q` range and its implied `s` at
every fitted gap).

**The shipped point is the set's MINIMAX CENTRE** in that same SE-scaled sup-norm — the Chebyshev
centre — so the shipped constant is at most half the set's own width away from any member of it. No
tie-break by curvature, saturation, or any other property the deliverable cannot see.

**Grid-edge rule (prong 2, re-derived).** If the EQUIVALENCE SET reaches a grid edge, the family is a
misfit and the result is unshippable — a STOP. Note the test moved from the pinned point to the SET:
under a rule with no directional tie-break the centre cannot run to an edge by construction, and what
would signal misfit is the deliverable being unable to distinguish members arbitrarily far out.

---

## A2.3 The fitted set — ruling (y). GOLD IS FITTED OUT. MONOTONE STAYS.

Amendment 1 fitted gold in and justified it by noise weighting. That argument was right about gold's
LEVERAGE and wrong about the SIGN of the conflict, and it is reversed on measurement.

**The structural fact:** gold at gap 15.02 needs 1.78 — ABOVE silver's 1.47 at the HIGHER gap 17.53.
**Gold's need is NON-MONOTONE in the coordinate.** Monotonicity is kept, because a non-monotone `s(g)`
would reorder tiers on the very axis it is fitted along. Therefore **no monotone `s(g)` can carry gold
and the coherent four at once** — a structural incompatibility, measured, not a tuning failure.

**The capability probe prices it:** gold out, the family reaches the coherent four at `q ≈ 2.4` with
4 of 5 inside and DIAMOND IN; gold in, the same probe collapses to `q = 1.00`, 2 of 5, diamond OUT.
Buying one tier by corrupting four is strictly dominated.

**FITTED SET = THE COHERENT FOUR: iron, bronze, silver, diamond** — the pre-registered set, unchanged,
and already the set the span measure used.

**GOLD SHIPS AS A PUBLISHED QUANTIFIED RESIDUAL**, not absorbed and not silently dropped:
`residual = need_gold − s(g_gold)`, **with a bootstrap CI**, attributed to the **composition / cohort
axis** — gold's break is an identity bump on this coordinate, and the composition layer is task 2's
territory and is not built. The five named light-usage cards continue to travel with it.

---

## A2.4 The acceptance bar, restated

**GATE (600-bar needs): at least 3 of the 4 COHERENT tiers inside their measured bootstrap CI, and
DIAMOND MUST BE ONE OF THEM.** A diamond miss remains STOP-class and is not tradeable. Gold is NOT
scored — it is reported.

- Gates re-checked at **p = 0.25 and 0.35** (acceptance D, unchanged).
- The **1000 bar remains a SENSITIVITY REPORT**, never a gate — A1.1's structural reason is untouched
  by anything in this amendment.
- **The held-out budget formats (bronze-cap-weekly, gold-slots, gold-cap) are DIAGNOSTICS, not gates.**
  Their elevation is the EXPECTED stratum-C composition signal, and reading it as a failure of the core
  fit would attribute a composition defect to the core — exactly what A1.3's stratification forbids.
  Resolved from the corpus REGISTRY by `tournamentId`, never from a `legacySlug` list.
- **Provenance unchanged and mandatory**: `fit-N = 50`, `fit-p = 0.30` stamped on the constant with
  **scoring-side assertions**, plus the **capture tripwire** (§5.5, §5.6). These ship WITH the constant.

---

## A2.5 What else is re-derived, because the objective and the selection rule changed

Contract clause 4: a rule inherited across an objective or coordinate change is a DEFECT until
re-derived. Auditing every rule in this document against that test:

- **(w)2 boundary-pin** → re-derived as the equivalence-set-at-grid-edge rule of A2.2.
- **(w)3 leave-one-out** → moves into DELIVERABLE SPACE. Four refits, one per coherent tier dropped;
  each refit's implied `s(g_t)` must lie inside the FULL fit's bootstrap `s`-CI at every fitted gap.
  Raw `{A, q}` comparison is dropped for the reason this program already pins — two selections give two
  selection outcomes, so comparing them compares the rule rather than the fits. Raw parameters are
  still PRINTED, just not gated on.
- **(w)1 identifiability** → UNCHANGED. It is a property of the COORDINATE, not of the objective, and
  its figures were recorded before any fit was seen.
- **The needs** → unchanged in definition (mmse slope, B = 2000, fixed seed, BF ≥ 600) and RE-MEASURED
  on this coordinate, never carried.
- **The family** → unchanged: `s(g) = 1 + A·(g/20)^q`, `s(g ≤ 0) = 1` exactly, monotone.

---

## A2.6 Kill conditions, restated in full

1. Gate (w)1 identifiability fails.
2. The equivalence SET reaches a grid edge (family misfit).
3. Leave-one-tier-out instability in deliverable space.
4. **Diamond outside its CI — STOP-class.**
5. Fewer than 3 of the 4 coherent tiers inside their CI.
6. A fitted form non-monotone over the observed gap range.
7. Gates holding at p = 0.30 but failing at BOTH 0.25 and 0.35 — that reopens conditioning, which is a
   ruling and not a fit decision.

A partial pass stays a partial pass. Anything on this list = STOP and report; overrules are not mine.

(end of amendment 2 — C3)
