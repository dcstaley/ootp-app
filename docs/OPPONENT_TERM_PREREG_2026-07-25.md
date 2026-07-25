# OPPONENT-AWARE MODEL FORM — PRE-REGISTRATION

**2026-07-25. Written BEFORE any fit. Nothing is fitted, wired, or retrained until this is confirmed
and an independent refuter has run against it. Production stays `league-42-43` / `model-woba` /
guarded throughout every measurement phase.**

This prereg is the primary integrity control (role-collapse operating frame: one model owns both
authority and execution, so the gates below must be numeric and must precede every result).

> **SCOPE REFRAME (Derek, 2026-07-25 — endorsed and adopted).** The first draft of this document
> proposed ADDING an opponent term to the deployed model. That framing is withdrawn. The deployed
> FORM was selected by a bake-off in which **every candidate was opponent-blind**, so the form
> decision itself is suspect — see §2. Opponent-awareness is therefore treated as an **AXIS IN THE
> FORM SELECTION**, not a patch on its winner.

---

## 1. THE ESTIMAND

Not "how big is the opponent term." Rather: **what is the best event-model form, given that
opponent-awareness is available as a structural option?**

Two things are estimated together because they are not separable:
- the FORM of each channel's own-rating curve, and
- the strength of the opponent's contribution, as ONE scale per channel on the pricing the model's own
  complementary curve already implies.

**Default scale = 1.00** — i.e. the opponent counts for exactly what the model already says that
rating point is worth. A channel whose scale the data cannot pin STAYS at 1.00. It is not dropped, not
special-cased, and not set to zero. (Recorded because I twice tried to narrow scope on channels whose
estimates were inconvenient; see §3.)

---

## 2. WHY THE EXISTING FORM DECISION IS SUSPECT

`predictPitching` and `predictHitting` see ONLY the card's own ratings. Every event is a joint
pitcher-batter outcome. Measured share of each channel's residual mean-square explained by matchup
composition alone (`fixtures/opponent-term-channel-survey-2026-07-25.txt`):

| channel | own ↔ opposing | share | pricing ratio (1.00 = the model's own pricing) |
|---|---|---|---|
| PITCHER BB | con ↔ eye | **62.6%** | 0.76× [0.69, 0.85] |
| PITCHER K | stu ↔ kRat | **53.8%** | 1.14× [0.86, 1.38] |
| HITTER BB | eye ↔ con | **38.9%** | 0.60× [0.51, 0.68] |
| HITTER K | kRat ↔ stu | **31.0%** | 1.30× [1.10, 1.52] |
| HITTER hits | babip ↔ pbabip | 14.1% | 3.93× — see §3 note |
| HITTER HR | pow ↔ hrr | 11.5% | 0.82× [0.43, 1.19] |
| PITCHER HR | hrr ↔ pow | 9.6% | 0.61× [0.41, 0.83] |
| PITCHER hits | pbabip ↔ babip | 3.2% | −0.16× — see §3 note |

**THE ARGUMENT.** Given a large systematic residual it has no proper channel for, a form search will
select whichever candidate BENDS ENOUGH TO ABSORB IT. Flexibility then scores well for a reason
unrelated to correctness. Two concrete instances are already measured:

- **`stuffAug` (a shipped FORM FEATURE) is 63.9% composition.** Controlling for matchup composition
  takes the pitcher BB aux from −1.1933 to **−0.4305, CI covering zero**, on the very window its
  deployed coefficient came from. It was added to fix a residual, and two-thirds of that residual was
  the missing opponent.
- **The pitcher K curve's apparent need for extra curvature is 53.8% composition.** The
  "quadratic isn't flexible enough" reading was largely the opponent pushing on the own-rating curve.

⇒ The bake-off compared opponent-blind forms against each other while all of them were partly
competing on absorption. **Closing the omission can change the ranking, and the current winner is a
live candidate for being OVER-flexible once its extra job is removed.** Bolting an opponent term onto
a form selected to compensate for its absence yields the correction AND the compensation — both
fitted, partly cancelling, more parameters than either needs.

**`stuffAug`'s historic validation could not have caught this.** It passed in-sample, CV and both
out-of-time directions — but platoon matchup structure is STABLE across seasons, so a proxy for it
passes every within-league out-of-time test by construction. Only changed composition (tournaments)
exposes it. This is a general warning about the whole existing validation record, not one term.

---

## 3. SCOPE — every pairable channel, both roles

**IN: BB, K, HR and BABIP/hits — BOTH ROLES. Eight channels.**

**OUT — exactly one, for a STRUCTURAL reason:** `HITTER XBH`. No pitcher GAP rating exists in the
game and `predictPitching` hard-codes the 0.25 XBH share. There is nothing to pair it against.

**EXCLUSION RULE, pre-committed:** a channel leaves scope ONLY if it is structurally impossible to
pair. **NOT because its effect is small, and NOT because its estimate is inconvenient.**

> Recorded: I twice proposed narrowing this and was wrong both times. First I dropped the HR channels
> on a ranking computed in EVENT space (events/600) when the deliverable is wOBA, where a HR carries
> ~4× the weight of a single — the wrong space, against the program's own deliverable-space rule.
> Then I dropped BABIP on the argument that the BIP chain would carry it. **It does not:**
> `BIP = 600 − BB − K − HR − adj` propagates the VOLUME of balls in play, but the hit RATE on those
> balls is computed from the pitcher's own contact-suppression rating alone — so BABIP would have
> stayed opponent-blind, which is the exact defect being fixed. BABIP is also not small: residual sd
> ~3/600, comparable to K and far above HR.

**NOTE on the two hits estimates.** `PITCHER hits` reads −0.16× (wrong sign, CI [−0.67, +0.27]) and
`HITTER hits` reads 3.93× off a composition gap of only 0.19 rating points. Neither is a usable
estimate — but that is a limitation of the DETECTION instrument, not evidence about the effect. The
platoon contrast identifies well where platoon splits move the opposing rating a lot (opposing eye
gap 23.1 points, avoid-K 6.37) and poorly where they do not (babip 0.19, pbabip 0.77). **Under §1's
default these channels simply sit at scale 1.00 unless the fit pins them otherwise.** No special case
is required and none is made.

---

## 4. THE CANDIDATE SPACE

### 4.1 How the opponent enters (binding design constraint)

**As a PROFILE, never as a single paired rating.** Measured: the full opposing profile beats the
single paired rating at leave-one-cell-out on 7 of 8 channels; opposing ratings are correlated (mean
|r| 0.45 hitter side, 0.35 pitcher side; pitcher `stu`↔`pbabip` = +0.80), so a paired rating stands in
for a bundle. The one channel where the paired rating won (`HITTER hits`, 0.55 vs 0.60) is the channel
with no matchup signal, and **no exception is carved for it** — a structural argument is not
overturned by one noisy cell. This is [[rating-shape-not-quality]] applied to the opponent.

The natural satisfying construction: the opponent enters via **the model's own predicted rate for the
opposing card**, which is a function of that card's whole rating vector through the existing curves.

### 4.2 Structures compared

- **S0 — opponent-blind** (the status quo; the null every other structure must beat).
- **S1 — odds-ratio / log5 combination (LEADING).** Combine this card's predicted rate with the
  opposing card's predicted rate, both relative to a league baseline, in log-odds space, one scale per
  channel. Profile-based by construction; reuses existing curves; the standard structure for this
  problem.
- **S2 — linear opponent shift** on the predicted rate, scaled per channel.
- **S3 — matchup coordinate** (`own − μ_opp` into the existing curve), the shelved
  `src/model/matchup.ts` Phase-1 structure. **Carries prior evidence against it:** frame-v2's additive
  rating shift was REFUTED on the value path (it compressed hitters, CI-clear). S3 is not identical
  but shares the additive-in-rating-space assumption and must clear that explicitly.

### 4.3 Forms compared (crossed with the structures)

The existing bake-off families, re-run: log, raw-poly at degrees 1–3, log-cubic, and the linear /
BIP / per-BIP variants already in `FORM_ENTRIES` (`src/training/forms.ts`).

**`stuffAug` is demoted from a fixed feature to a CANDIDATE** and must re-earn its place against
S1–S3; if the opponent term supersedes it, it is REMOVED, not retained alongside.

### 4.3a **THE DEPLOYED FORM IS NOT IN THE BAKE-OFF REGISTRY — it must be added** (Derek, 2026-07-25)

Verified in code. `saveTrainedModel` (`src/server/server.ts:1567`) fits
`fitHitForm(RAWPOLY_HIT, …)` + `fitPitForm(PARETO_PIT, …)` with `vertexPinned`. But `FORM_ENTRIES`
(`src/training/forms.ts:818`) contains **`RAWPOLY_HIT` ✓ and `RAWPOLY_PIT` ✗** — and
`RAWPOLY_PIT ≠ PARETO_PIT`:

| channel | registry `RAWPOLY_PIT` | DEPLOYED `PARETO_PIT` |
|---|---|---|
| bb | LOG | LOG |
| k | **LOG** | **Q2 (rawpoly-2)** |
| hr | rawpoly-2 | Q2 |
| h | **LOG** | **Q2** |
| stuffAug | **absent** | **present** |

So the DEPLOYED PITCHER FORM HAS NEVER BEEN COMPARED AGAINST THE CANDIDATE SET. `server.ts:1466`
dates the switch (StuffAug → PARETO_PIT, 2026-07-14), after the bake-off. Neither `STUFFAUG_PIT` nor
`SATBB_PIT` — both adopted or evaluated post-bake-off — is in `FORM_ENTRIES` either.

**This strengthens §2's argument.** It is not merely that every candidate was opponent-blind; the
deployed pitcher form is the product of a GREEDY SEQUENCE of local improvements, each validated
against the then-current deployed form rather than against the field — and at least two of those
improvements (`stuffAug`, the K curvature) are now measured as substantially absorbing the missing
opponent.

**REQUIRED AMENDMENTS:**
1. **S0 (the null every structure must beat) is the EXACT DEPLOYED CONFIGURATION** — `RAWPOLY_HIT` +
   `PARETO_PIT` + vertex pinning, fitted exactly as `saveTrainedModel` fits it. Not `RAWPOLY_PIT`,
   not "the bake-off winner."
2. **Add to the registry as explicit candidates:** `PARETO_PIT`, `STUFFAUG_PIT`, `SATBB_PIT`, and any
   other form adopted or seriously evaluated after the original run.
3. **Verify the bake-off's fit path matches the trainer's.** `saveTrainedModel` passes `vertexPinned`
   and the fitters auto-refit any quad channel whose unconstrained vertex lands in-domain. If
   `FORM_ENTRIES` does not apply the same pinning, the comparison is not scoring what we ship.
   Confirm before P2, and record the answer either way.

### 4.4 The entanglement, and how it is resolved

Under S1–S3 the pitcher's prediction depends on the hitter's curves and vice versa, so the two roles'
forms are a joint fit. **Resolution: iterate to a fixed point** — fit hitters against the current
pitcher form, refit pitchers against the new hitter form, repeat. Convergence criterion in G5.

---

## 5. PHASES — the cheap kill comes first

**P0 — this prereg + an independent refuter.** No fitting.

**P1 — SIZING (cheap, killable).** Add S1 to the CURRENT form only. Fit the eight scales. Measure
whether it absorbs the composition structure and whether out-of-time metrics move. **This phase alone
can end the project** (see G1/G2 and §10). Do not proceed to P2 without passing it.

**P2 — FORM RE-SELECTION.** Structures S0–S3 crossed with the form families, `stuffAug` as a
candidate, on the existing harness (`src/training/bakeoff.ts`, `evaluate.ts`, `metrics.ts`) with its
existing fold discipline.

**P3 — JOINT CONVERGENCE** of the two roles' forms (§4.4).

**P4 — THE ATOMIC EVENT** (§7).

---

## 6. GATES — numeric, pre-committed. A gate decided after seeing a result is not a gate.

**G1 — P1 KILL GATE: THE TERM MUST ABSORB WHAT MOTIVATED IT.** After S1, the share of residual
mean-square explained by matchup-cell fixed effects must fall **below 15%** in the four channels where
it is currently large (62.6 / 53.8 / 38.9 / 31.0). Failure in **both** pitcher BB and pitcher K — the
two largest — means the mechanism is wrong ⇒ STOP, do not proceed to P2.

**G2 — NO PREDICTIVE REGRESSION, P1 AND P2.** On the existing harness, weighted Pearson, top-N overlap
and value-regret must be **no worse than the current model in BOTH out-of-time directions** (forward
and backward). Any regression ⇒ STOP.

**G3 — IDENTIFICATION, per channel.** A scale is moved off its 1.00 default only if CI-clear (95%,
**card-cluster bootstrap** — row bootstraps ran ~3.1× too narrow on this data) AND sign-consistent on
held-out seasons. Otherwise it stays at 1.00. Report every scale with its CI, including those left at
default, and the power of each null (Amendment 2 RULE M3).

**G4 — FORM SELECTION IN DELIVERABLE SPACE.** Forms are equivalent iff implied per-tier deliverables
differ by less than need-SE; pick the simplest in the equivalence set; **publish the equivalence set**.
A winner at a family/grid edge is family misfit, not a fit.

**G5 — CONVERGENCE.** The P3 iteration must reach a fixed point: every scale moving < 0.02 and every
implied per-tier deliverable moving < need-SE between successive iterations. Non-convergence ⇒ STOP
(it would mean the joint specification is unstable).

**G6 — EXTRAPOLATION SAFETY.** Tournament pools carry opposition far outside the league range. Every
selected structure must be bounded and monotone-safe beyond the fitted opposition domain, verified at
the extremes of **every registry format's pool**. Unbounded ⇒ STOP. (Written by the K-cubic hazard and
by the fact that the hit.hr curve's fitted domain edge IS the league maximum — league data never
exercises what tournament pools do.)

**G7 — DOWNSTREAM CORRECTIONS REFIT AND GATED.** `K_SPREAD_PIT`, `PIT_SPREAD_HR` and `PINNED_HIT_TAIL`
were all fitted against residuals containing this omission. All three refit on the new model, then the
full C6 gates + Scorecard v2, **no worse than the shipped baseline** (LEVEL 20/34/86, SHAPE 2/110/28).
Provenance stamps re-issued.

**G8 — RESIDUAL LEDGER.** Six published residuals stand. No seventh without an explicit STOP stating
why six did not already mean stop.

---

## 7. THE ATOMIC EVENT (clause 4)

This changes the CORE MODEL and therefore cannot ship incrementally:

`structure + form in code` → `retrain` → `stuffAug re-earned or removed` → `all three cwhit corrections
refit` → `full gates + scorecard` → `activation` → **one** Derek regenerate.

No intermediate state is activatable. The activation guard shipped 2026-07-25 enforces the ordering.

**THIS IS NOT own-gap / frame-v2 and must not double-count with them.** Those corrections are
pool-level and are the exact identity at zero pool gap — they vanish in-frame by construction. The
defect here is present IN-FRAME, inside league play. So this changes league predictions, and every
existing correction is stale the moment it lands. That is why G7 is part of this event and not after it.

---

## 8. RISKS, STATED BEFORE THE FIT

- **Manager-selected exposure.** Same-side matchup frequency is a property of how this league's AI
  deploys pitchers, so the MAGNITUDES are corpus properties. What transfers is the RESPONSE, evaluated
  at each pool's own opposition — but its precision is corpus-limited and must be re-measured before
  being trusted far out of frame.
- **Collinearity with own ratings.** Matchup cell correlates with pitcher hand, which correlates with
  card composition. Report conditional estimates, controlling for own ratings.
- **Blast radius.** The whole correction layer. This is the largest change proposed since the model
  was deployed.
- **Thin design on the profile question.** 28 (season × cell) design points against 4–5 predictors —
  directional, not a measurement. G4 decides it.
- **Sequencing:** the matchup-structure sweep now runs AFTER this, not alongside. It measures where
  predictions miss, and this changes those misses.

---

## 9. PROCESS REQUIREMENTS

- **An independent refuter runs against this prereg before it is confirmed**; its refutation is
  appended here.
- **Bootstrap by card cluster**, always; report distinct-card counts beside every row count.
- **Permutation nulls on any interaction claim** — eye-catching corners failed them repeatedly
  (p = 0.485 / 0.357 / 0.883 / 0.902 / 0.998).
- **In-sample caveat:** a channel whose fitted design already carries a rating has ~0 slope on it BY
  LEAST SQUARES, so "the residual lands on channel X" can be structure, not mechanism.
- **Out-of-time is not out-of-card** on this corpus: the same cards recur across seasons with
  residuals correlating r = 0.94, so cross-season agreement is close to arithmetic. Card-disjoint
  replication is not available and must not be claimed.

---

## 10. THE NULL — a real, acceptable outcome

If P1 shows S1 absorbs little of the composition structure and out-of-time metrics do not move, then
the compensation built into the current form was doing the job adequately. **The correct outcome is
then: keep the current architecture, document the in-frame defect as a known limitation, close this
item, and do NOT proceed to P2.** That is a result, not a failure, and P1 exists to reach it cheaply.

(end of pre-registration — opponent-aware model form)
