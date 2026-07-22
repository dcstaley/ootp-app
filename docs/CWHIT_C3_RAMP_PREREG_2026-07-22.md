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
