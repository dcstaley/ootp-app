# HR-ramp refit — PRE-REGISTRATION (part of the C3 constants event, extend per Fable option (a)).

**2026-07-22. Written BEFORE any fitting, for Fable's approval. No fit runs until this is approved.**

The C6 sweep STOPped: with the two published residuals carved, every remaining blocking failure is a
STALE CORRECTION — a correction whose gate record was set at the pre-C1/C2′ coordinate and never
re-fit on the current one. Fable ruled **option (a): extend the event and refit the stale corrections
on the current coordinate before shipping**, and pinned the program-scale rule that **a coordinate
change and every correction consuming it ship as ONE ATOMIC EVENT**. This is the HR ramp's refit.

The HR failures C6 found: **Bronze Quick G1-HR 0.86 [0.73,0.99]** (marginal, misses by 0.01) and
**Late Bronze G2 −0.129** (its G1-K is fine, so the HR ramp is the suspect for the ordering loss).

---

## 1. THE CLAUSE-4 AUDIT (required before fitting — every inherited rule is a defect until re-derived)

`tools/fit-pitspread-hrbab.ts` fits `PIT_SPREAD_HR` today. Auditing every rule it carries against the
coordinate move (C1/C2′) and the estimand ruling (z):

**A. THE ESTIMAND — the pivot conflation, exactly as C3 had it (ruling (z)).** The current objective is

    HR_corr = HR̄_pool + s_hr(g)·(HR_pred − HR̄_pool)

— a residual taken **about `HR̄_pool`**, with NO per-tier free level. cwhit's tables are the top by
usage, so the judged sample sits off `HR̄_pool`, and that residual prices the sample's LEVEL offset as
well as its SPREAD. This is the identical defect ruling (z) corrected for C3: the estimand must gain a
per-tier free level, so that `s_hr` is a pure spread response and level lives in the anchor layer.
**RE-DERIVED:** free-slope estimand with per-tier free level, exactly as C3's amendment 2.

**B. THE INSTRUMENT — the tool fits on the PHANTOM pre-C2′ coordinate (§15.8 exhibit 4 again).** It
builds fields with `computeUnifiedFieldStats(pool, …, FIELD_N, true)` and pool means with
`poolPitMeansOwn(…, FIELD_N)` — variant-free, unscaled `FIELD_N`, NOT the presence mixture. Production
now builds every field through `productionFieldStats` (presence mixture, `FIELD_N × PRESENCE_M`). So
the tool measures a DIFFERENT COORDINATE from the one production scores on — the precise defect that
would have passed every C3 gate on a phantom coordinate. **RE-DERIVED:** the refit uses
`productionFieldStats` and the presence mixture, so `g_hr` and `HR̄_pool` are production's, not a fork.

**C. THE FAMILY — do NOT inherit C3's convex answer.** C3's needs were convex in gap; the HR need was
measured **gap-FLAT** (iron/bronze/silver/gold HR9 slopes 1.30/1.23/1.25/1.31 at hrr-gaps
47.7/36.3/27.6/17.5 — no monotone geometry), which is why a saturating form pinned for early
saturation passed before. That measurement was on the OLD coordinate and is re-measured here, but the
family question is genuinely open and DIFFERENT from C3's: HR may be a constant amplification, not a
ramp. The prereg declares the family as **the minimal form that contains both a constant and a
monotone response**, and lets the deliverable-space selection decide — see §3.

**D. SELECTION — the SSE / g_min-pinning rule does not survive.** `PIT_SPREAD_HR` pins `G = g_min/3`
(95% saturation at the lowest tier gap) and `A` by precision-weighted SSE. Both are inherited rules
calibrated on a tier-aggregate SSE and the old coordinate. **RE-DERIVED:** deliverable-space
equivalence with a minimax centre, exactly as C3's ruling (x) — two candidates are equal iff their
implied `s_hr(g_t)` differ by less than the per-tier need SE at every fitted gap.

**E. FORMAT REACH — legacySlug, not the registry.** The tool reaches dailies via `formatByLegacySlug`
(4 of the registry's 8). **RE-DERIVED:** held-out formats resolve from the corpus registry by
`tournamentId`, exactly as C3 and C6.

**F. WHAT IS NOT TOUCHED, and why it is safe to leave.** BB9 is 0.99 (calibrated) and is not a
correction — nothing to refit. The pitcher BABIP scalar was HELD at the bronze G1 fail and is never
set in production — there is no shipped BABIP correction, so it is out of scope. The K ramp is C3 and
already refit.

---

## 2. THE COORDINATE, MEASURED FIRST (recorded before the fit, like C3's §2)

The HR gap `g_hr = buildFrameShift(trainingMeans, productionFieldStats(pool)).pit.vR.hrr` will be
tabulated per Quick tier at p = 0, 0.25, 0.30, 0.35 as the FIRST output, and the identifiability
prong (ordering + span retention ≥ 60%) checked on it BEFORE any fit — so the gate cannot be re-read
after the fit is seen. If the HR need is genuinely gap-flat, ordering is not expected to be
informative, and that is stated in advance as a family question, not a gate failure.

---

## 3. THE FAMILY AND THE SELECTION

**Family:** `s_hr(g) = 1 + A·(g/G0)^q`, `s_hr(g ≤ 0) = 1` exactly, `G0 = 20` fixed (units of A). This
is C3's family, chosen for ONE reason: it contains the CONSTANT response (`q = 0` ⇒ `s = 1 + A`
everywhere above 0) AND the monotone response (`q > 0`) as members, so "HR is a flat amplification"
and "HR is a ramp" are both IN the family and the deliverable-space selection decides between them
rather than a family choice pre-judging it. **The domain rule (amendment 3) applies identically:**
flat-hold above the largest fitted gap, because a convex member is unbounded above and HR's fitted
range does not reach the live-pool gaps either.

**Estimand:** per-card residuals, per-card noise weights `1/per9NoiseVar(obs, BF)`, and a PER-TIER
FREE LEVEL — the same three-sum reduction C3 uses, on `g_hr` and `HR̄_pool` from the presence mixture.

**Selection:** deliverable-space equivalence, minimax centre, equivalence set published in full,
set-at-grid-edge = family misfit. Comparisons on `s_hr(g)` over the observed range, never on `{A, q}`.

**Baseline:** the C3 K ramp is ACTIVE at every step (pre and post both carry it), because that is the
shipping reality the HR residual sits on top of. The refit measures HR's residual GIVEN the shipped K
ramp, not against a stale K line.

---

## 4. GATES (anchored to the CURRENT coordinate and bars — nothing inherited)

1. **IDENTIFIABILITY** (prong 1 ordering + span ≥ 60%; prong 2 equivalence-set-interior; prong 3
   leave-one-tier-out in deliverable space) — the C3 gate battery, verbatim.
2. **G1-HR ACCEPTANCE:** implied `s_hr(g_t)` inside the measured bootstrap CI for the coherent tiers,
   the coherent-set and diamond-mandatory rule to be set with the measured needs (the HR coherent set
   is NOT assumed equal to K's — it is declared once the needs are measured, before the fit is scored).
3. **G2 ORDERING MUST NOT DROP CI-CLEAR**, in every stratum, on the composite — the C6 gate that
   caught late-bronze. This is the gate the current HR ramp fails, so it is first-class here.
4. **HITTER + K BIT-IDENTITY:** the HR refit is pitcher-HR-only; K lines and all hitter lines must be
   bit-identical pre/post. A leak is a STOP.
5. **BAND re-check at p = 0.25 / 0.35**, and **provenance stamped + asserted** (`fitN`, `fitP`, `gMax`)
   exactly as C3 — `PIT_SPREAD_HR` joins `K_SPREAD_PIT` under `assertKSpreadProvenance`.
6. **HELD-OUT** dailies + budget from the registry, DIAGNOSTIC not gate (stratum B/C), their elevation
   the expected era/composition signal.

Any gate failing ⇒ STOP and report; overrules are Fable's or Derek's.

---

## 5. WHAT SHIPS, AND HOW IT JOINS THE ATOMIC EVENT

On a pass, `PIT_SPREAD_HR` becomes `{ A, q, G0: 20, gMax, fitN: 50, fitP: 0.30 }` on the C3 family,
and is wired at the same seam it occupies today (`applyPitSpread`, pre-BIP pre-era). It ships in the
SAME dated commit as C3 and the hitter-tail refit — the atomic-event rule — never on its own. The
final C6 sweeps the coherent triple before any of it is announced to Derek.

(end of pre-registration — HR-ramp refit)

---

# AMENDMENT 1 — Fable's approval. 2026-07-22. The coherent-set RULE, pre-committed.

Approved with one amendment replacing "measure-then-declare the coherent set": pre-commit the RULE,
not the set. This governs §4 gate 2.

1. **Default fit set = all five tiers.**
2. **Exclusion only by the mechanical monotone-feasibility test:** a tier is excluded iff no monotone
   curve passes through all five need-CIs AND its removal restores feasibility with maximal margin —
   deterministic given the measured needs, not a judgment call after seeing the fit.
3. **Excluded tiers become tracked published residuals** (gold semantics: re-measured every sweep,
   re-block on CI-clear growth beyond the published interval).
4. **More than one exclusion on a channel = STOP** — that is a family/coordinate failure, not
   carve-out material.
5. **Diamond-mandatory does NOT transfer** (it was K-specific history). Channel-general replacement:
   the **SMALLEST-GAP tier in the fit set is mandatory-within-CI** — it anchors `s(g→0) = 1`, and a
   low-end miss is never acceptable.

(end of amendment 1 — HR-ramp refit)
