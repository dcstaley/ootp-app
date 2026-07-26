# The cap/slots objective vs the E[wins] evaluator — size, attribution, and what would settle it

**2026-07-26. Investigation only.** No repo file was changed and nothing was committed. All
measurement ran against a scratch copy of the repo with probe endpoints added, served on ports
**8911–8914**. Ports 8787 and 5173 were untouched.

**Provenance.** HEAD advanced to `990e385` during this work (the consistency-sweep fixes plus three
modeling investigations). Verified before publishing: `git diff 7c8a061..990e385` is **empty** for
`src/optimizer/roster-lp.ts`, `src/eval/offense.ts`, `src/eval/set-eval.ts` and
`src/eval/expected-wins.ts`; the only change touching `ewinsInputs`' caller is `rosterOptions`
substituting `...teamExposure(exp, t)` for a numerically identical inline expression. The objective
and the evaluator are unchanged, so every measurement below stands against current HEAD.

---

## Read this first

The cap/slots optimizer picks a roster by maximising a linear objective. A separate formula,
`setExpectedWins`, then scores that roster and prints an E[win%] next to it. **The two disagree
about which roster is better** — on most, though not all, cap/slots formats there is another roster
the optimizer could have returned that its own evaluator rates higher.

### The single most important result: it is one term, and one number controls it

Almost the entire disagreement — **63 % as the formats are configured, 84–91 % once the deliberate
segment dials are set aside** — comes from **how the two formulas price bench depth**. Nothing else
comes close: the batting-order PA curve is −4 % to +7 %, and the Pythagorean nonlinearity is ~1 %.

That term is scaled by a single constant: **`fullStrengthShare`** (`f0`, in
`src/eval/expected-wins.ts`, default **0.6**). Read plainly, it is the claim *"a team fields its best
nine in 60 % of games, and in the other 40 % one starter is missing and someone off the bench
replaces him."* It has never been calibrated against anything. It sets both the evaluator's
availability weighting and the optimizer's `benchPA` proxy.

Re-running the whole measurement with `f0` overridden, on `bronze-cap`:

| `fullStrengthShare` | gap (pp) | alternatives that beat the MILP's pick |
|---|---|---|
| 0.2 | 0.2861 | 10 / 26 |
| 0.4 | 0.4557 | 7 / 26 |
| **0.6 (shipped)** | **0.5815** | **11 / 26** |
| 0.8 | 0.0089 | 1 / 26 |
| 1.0 | 0.0166 | 2 / 26 |

**What follows from this, in one sentence:** the disagreement exists *because* depth is given real
weight, it disappears only if depth is given almost none — and the real tournament data says depth
deserves **more** weight than either formula gives it, not less. So this will not be calibrated away.

That last clause is the load-bearing one, and it is now measurable. On **487 complete 26-card
tournament rosters with realised per-card playing time** (`Tournament Data/`), real teams spread
plate appearances over an effective **12.08** hitters. The optimizer's usage model implies **10.47**
and the evaluator's **10.09** — and on that roster shape the evaluator's *form* cannot reach 12.08
at **any** value of `f0`: even at `f0 = 0` it tops out at **11.15**. Both formulas under-credit
depth, and one of them cannot express the observed amount at all.

### Does this say which ranker is right?

Partly, and this is the more valuable half of the answer.

- **On the PA curve, the evaluator is right and the objective is refuted.** Ranking each real
  roster's hitters by the app's *own* predicted offence (exogenous to realised playing time), the
  best hitter takes **16.3 %** more PA than the ninth (n = 487). The objective assumes **0 %** — it
  prices every lineup seat identically, which is exactly the assumption "the batting order is
  random". The app's own Lineups tab already seeds the order **best-first**. The evaluator's assumed
  slope (1.316:1) is if anything ~2× too steep against the measured 1.16–1.40, but it is the one
  with the right sign.
- **On the bench term, the evaluator has the right functional form and the wrong scale; the
  objective has the wrong form.** Depth value is intrinsically *marginal* — a bench bat is worth the
  difference between it and the starter it replaces, amplified by positional flexibility. A per-card
  linear term cannot express a marginal at all. That is a structural verdict, not a preference.
- **On the Pythagorean term, both are effectively right, because it does not matter.** Reallocating
  a full 20 runs between offence and defence moves E[win%] by **0.034 pp**; the curvature costs
  **0.017 pp**. ~1 % of the gap. No linear-objective change should ever be justified by it.

**But nothing here says which ranker orders rosters better overall, and nothing available can.**
The same corpus has realised W-L, and it is short by 8–35×: discriminating a 0.5 pp difference at 2σ
needs ~12,600–17,700 team-runnings depending on the completeness filter, and there are 498 complete
(1,628 total). See §4.3 — that limit is robust to loosening the filter, which is the first thing
checked.

### Recommendation, in brief

Marked as a **recommendation, not a decision** — the runtime trade is the user's call.

1. **Add the tripwire** (a characterisation test that fails when the two orderings diverge beyond a
   pinned tolerance). Cheap, no behaviour change, keeps the alarm.
2. **Calibrate the shared usage model against `Tournament Data/`** — `f0` first, then the lineup PA
   curve. This is the only move where new evidence, rather than a preference between two unvalidated
   formulas, decides the answer. Expect it to *widen* the gap, not close it (measured above).
3. **Then, for the residual, generate-then-rescore on a reduced pool is the practical option** —
   and it is much cheaper than it looks. Measured: the `refineUpgrades` pool reduction reproduces
   the full-pool optimum *exactly* and cuts the per-solve cost **12–22×** (5,003 ms → 407 ms;
   1,645 ms → 74 ms). 26 diversified re-solves cost 4–23 s on top of the existing ~5 s solve.
4. **Do not adopt the "carry the real PA curve in the objective" fix on its own.** It was built and
   measured. It costs ~2× solve time, left the roster unchanged on 3 of 4 formats, and on the
   fourth moved it 0.11 pp in the *wrong* direction by the evaluator's own reckoning.

And the trade that has to be said out loud: **making the two formulas agree is not evidence that
either is right.** Nobody consumes the E[win%] number — it is display-only; `setExpectedWins` never
enters selection. A change that silences the disagreement without calibrating the usage model
removes the signal and keeps the risk.

---

## 1. What was measured, and how the alternative was constructed

### 1.1 The instrument

A probe endpoint (`/api/debug/objgap`) added to a scratch copy of `server.ts`. For one tournament it
builds the real candidate pools (`rosterCandidates`), the real options (`rosterOptions`) and the real
E[wins] inputs (`ewinsInputs`) — no reimplementation — computes **one** `Dref` anchor from the
0-variant optimum and uses that same anchor for every roster in the run, solves the real MILP, then
builds a neighbourhood of alternatives and scores each with the real `setExpectedWins`.

### 1.2 The construction of "a roster it could have chosen" — and where it can go wrong

**Exclude-one re-solve.** For each of the 26 cards on the MILP's chosen roster, that card is removed
from the candidate pool and the real MILP is re-solved. The result `R_c` is:

- **feasible in the original problem** (its pool is a strict subset), so the MILP genuinely *could*
  have returned it — every budget, coverage, roster-size, variant and two-way constraint is decided
  by the actual solver, not by me;
- **optimal given the exclusion**, so it is the best alternative in that direction;
- **necessarily worse on the objective**, so any case where the evaluator prefers it is an
  unambiguous ranking inversion.

This is why it is preferred over the original sweep's nested-pool demonstration, where the two
rosters came from two different pools and it was fair to wonder whether the better roster was really
available.

**Limits, stated plainly:**

- It is a **lower bound**. 26 alternatives is a thin slice of a combinatorial space.
- The headline is a **maximum over 26 draws**. Under the sharp null (identical orderings) it is
  *exactly* zero — the base roster has the highest objective, so it would also be the evaluator's
  pick — so there is no winner's-curse inflation of a null. But it is the best of 26, not a typical
  disagreement; the count and median of alternatives that beat the base are reported alongside.
- In **slots mode the neighbourhood is coarser**: excluding one card often costs 3–15 % of the
  objective (vs 0.1–3 % in cap mode), because tier limits bind hard. The smaller slots gaps in §2
  are therefore partly a less sensitive test, not purely better agreement.

### 1.3 Reconstruction checks

- **Φ(set) by re-solve.** The MILP's own objective for a *fixed* roster was obtained by re-solving
  the real LP over a pool containing exactly that roster. It matched the original solve's
  `ObjectiveValue` and the analytic decomposition to 4 dp in every run — the `assignment` column in
  §3.2 is 0.0000 almost throughout. So for a fixed set the MILP's lineup/rotation/bullpen assignment
  is identical to the evaluator's `bestLineup` / sort-by-`vSP` / sort-by-`vRP`.
- **Defence is exact, not approximate.** `defenseRunsAboveAvg` = `Σ v·BF / wobaScale` because
  `lgWoba == TARGET_WOBA`, which is precisely the MILP's pitching terms. Measured `def − defLin =
  0.0000` on every roster in every run. **The entire disagreement lives in offence.**

---

## 2. Size and distribution

### 2.1 Scope

Of the 47 tournaments in `data/tournaments/`, **31 are `mode: "none"`** — legacy weighted objective,
no `WinParams`, no E[win%] computed or displayed. There is no objective/evaluator pair to disagree
there. That leaves **16 formats** (9 cap, 7 slots), **all measured**. Eight carry `tuning.dials`,
per-segment preference weights that by design make the objective deliberately *not* E[wins]; three
of those were additionally measured with dials neutralised, to separate the deliberate part.

### 2.2 Per-format results

`gap` = pp by which the best exclude-one alternative beats the MILP's own choice, on the app's own
E[win%], one shared `Dref`. `objMar%` = how far below the optimum that alternative sits.
`spread` = full E[win%] range across the 26 alternatives — the local decision range, for context.

| tournament | mode | dials | gap (pp) | objMar% | beat/alt | spread (pp) | K to reach max |
|---|---|---|---|---|---|---|---|
| `live-slots-weekly` | slots | as configured | **0.6029** | 11.895 | 6/26 | 1.634 | 24 |
| `bronze-cap` | cap | as configured | **0.5815** | 1.113 | 11/26 | 1.354 | 15 |
| `bronze-cap-weekly` | cap | *neutralised* | **0.4591** | 0.708 | 12/26 | 1.146 | 15 |
| `cwhit-cap` | cap | *neutralised* | **0.3494** | 1.319 | 3/26 | 0.685 | 14 |
| `gold-cap` | cap | as configured | **0.2197** | 0.991 | 10/26 | 2.256 | 14 |
| `cwhit-cap` | cap | as configured | **0.2096** | 2.659 | 4/26 | 0.582 | 22 |
| `nightmare-cap` | cap | none | **0.1972** | 1.020 | 11/26 | 0.954 | 4 |
| `bronze-cap` | cap | *neutralised* | **0.1453** | 0.603 | 2/26 | 1.044 | 13 |
| `bronze-cap-weekly` | cap | as configured | **0.1263** | 0.282 | 2/26 | 1.133 | 5 |
| `ptcs-cap` | cap | as configured | **0.1206** | 0.187 | 1/26 | 0.787 | 9 |
| `ptcs-live` | slots | as configured | **0.1099** | 3.832 | 3/26 | 1.291 | 22 |
| `diamond-cap-daily` | cap | none | **0.1040** | 0.157 | 5/26 | 0.985 | 3 |
| `gold-sporer-sandlot` | cap | none | **0.0834** | 3.488 | 7/26 | 0.666 | 20 |
| `live-time-slots` | slots | as configured | **0.0404** | 0.049 | 3/26 | 1.181 | 4 |
| `gold-slots` | slots | none | **0.0237** | 15.279 | 1/26 | 0.739 | 14 |
| `silver-slots` | slots | none | **0.0031** | 4.616 | 1/26 | 0.575 | 11 |
| `silver-deadball-slots` | slots | none | **0.0000** | 1.305 | 0/26 | 0.744 | 1 |
| `wonky-slots` | slots | none | **0.0000** | 0.381 | 0/26 | 0.389 | 1 |
| `silver-cap` | cap | none | **−0.0096** | 0.134 | 0/26 | 0.787 | 1 |

### 2.3 The distribution — it is not uniform

| cohort | n | min | median | max | mean |
|---|---|---|---|---|---|
| all runs | 19 | −0.010 | 0.121 | 0.603 | 0.177 |
| the 16 formats as configured | 16 | −0.010 | 0.104 | 0.603 | 0.151 |
| dialed formats, dials neutralised | 3 | 0.145 | 0.349 | 0.459 | 0.318 |
| **formats with no dials at all** | **8** | **−0.010** | **0.003** | **0.197** | **0.050** |
| cap mode | 12 | −0.010 | 0.145 | 0.581 | 0.216 |
| slots mode | 7 | 0.000 | 0.024 | 0.603 | 0.111 |

Across the 16 formats as configured: **4 are ≥ 0.2 pp, 5 are 0.1–0.2 pp, 1 is 0.05–0.1 pp, and 6 are
essentially zero (< 0.05 pp, three of them exactly 0.0000).** On `silver-cap` the finding **does not
reproduce at all** — no alternative in the neighbourhood beats the MILP's pick.

So this is **not** a uniform 0.5 pp tax. It is heavy-tailed: a handful of formats where it is
material and a substantial minority where it is absent. Correlation between the gap and the number of
bench hitters is weak (r = 0.18, n = 19), so the driver is not simply "more bench".

Two calibrating notes on magnitude:

- The 26 exclude-one alternatives span **0.39–2.26 pp** of E[win%]. A 0.2 pp gap is therefore on the
  order of **15–25 % of the entire range reachable by changing one card**. Where it bites, it bites.
- **The original sweep's headline case is mostly deliberate.** `live-slots-weekly` shows the largest
  gap here (0.6029 pp), and the attribution in §3.2 puts **−0.6016 of it in the segment dials** —
  that tournament carries `rotation: 0.5, bullpen: 0.5`, which by design halves all pitching value in
  the objective. That is a user preference working exactly as documented, not a structural defect.

---

## 3. Attribution

### 3.1 The ladder

For the pair (A = the MILP's choice, B = the alternative the evaluator prefers), six nested models
were evaluated on both rosters; each rung differs from the previous in exactly one respect.

| rung | what it is |
|---|---|
| `Φ` | the shipped MILP objective, dials as configured (obtained by re-solve, not reimplemented) |
| `Φ₁` | the same with segment dials set to 1 → isolates **dials** |
| `L` | `Φ₁` in runs: flat `avgPA` per lineup seat + flat bench proxy + exact defence → isolates **assignment** |
| `C` | `L` with flat `avgPA` replaced by the real per-slot PA curve → isolates **cause 1** |
| `R` | `C` with the bench proxy replaced by `offenseRunsAboveAvg` → isolates **cause 2** |
| `W` | `winPctFromRuns(R)` → isolates **cause 3** |

Contributions are converted to pp with the local slope `d(win%)/d(runs)` (≈ 0.062 pp/run, measured
per run at each base point) and sum exactly to the observed flip.

### 3.2 Result (pp; negative = pushes toward the alternative)

| tournament | dials | gap (pp) | dials | assignment | **PA curve** | **bench** | Pythagorean |
|---|---|---|---|---|---|---|---|
| `live-slots-weekly` | as cfg | 0.6029 | **−0.6016** | 0.0000 | −0.0174 | −0.0895 | −0.0119 |
| `bronze-cap` | as cfg | 0.5815 | −0.0461 | −0.0000 | 0.0150 | **−0.6445** | 0.0133 |
| `bronze-cap-weekly` | neutral | 0.4591 | 0.0000 | 0.0000 | −0.0792 | **−0.4060** | −0.0208 |
| `cwhit-cap` | neutral | 0.3494 | 0.0000 | −0.0007 | −0.0011 | **−0.4477** | 0.0011 |
| `gold-cap` | as cfg | 0.2197 | **−0.2622** | 0.0000 | −0.0085 | 0.0374 | −0.0291 |
| `cwhit-cap` | as cfg | 0.2096 | −0.1481 | 0.0000 | −0.0183 | **−0.3178** | 0.0005 |
| `nightmare-cap` | none | 0.1972 | 0.0000 | −0.0246 | 0.0000 | **−0.1810** | −0.0004 |
| `bronze-cap` | neutral | 0.1453 | 0.0000 | −0.0000 | 0.0022 | **−0.1906** | 0.0002 |
| `bronze-cap-weekly` | as cfg | 0.1263 | −0.0000 | 0.0000 | −0.0000 | **−0.1406** | 0.0002 |
| `ptcs-cap` | as cfg | 0.1206 | 0.0043 | −0.0000 | −0.0045 | **−0.1452** | −0.0001 |
| `ptcs-live` | as cfg | 0.1099 | −0.0320 | 0.0600 | −0.0407 | **−0.3464** | −0.0003 |
| `diamond-cap-daily` | none | 0.1040 | 0.0000 | 0.0000 | 0.0000 | **−0.1110** | −0.0043 |
| `gold-sporer-sandlot` | none | 0.0834 | 0.0000 | 0.0000 | 0.0241 | **−0.1936** | 0.0018 |
| `live-time-slots` | as cfg | 0.0404 | −0.0479 | 0.0000 | 0.0000 | 0.0023 | −0.0000 |
| `gold-slots` | none | 0.0237 | 0.0000 | −0.1033 | 0.0000 | 0.0223 | −0.0008 |
| `silver-slots` | none | 0.0031 | 0.0000 | −0.0000 | 0.0000 | −0.0475 | 0.0000 |
| `silver-deadball-slots` | none | 0.0000 | 0.0000 | −0.0000 | −0.0000 | −0.0458 | 0.0000 |
| `wonky-slots` | none | 0.0000 | 0.0000 | −0.0000 | 0.0000 | −0.0044 | 0.0000 |
| `silver-cap` | none | −0.0096 | 0.0000 | −0.0000 | 0.0000 | 0.0000 | 0.0002 |

Share of the total swing, by cohort:

| cohort | PA curve | **bench** | Pythagorean | dials |
|---|---|---|---|---|
| all 19 runs | 2.8 % | **70.2 %** | 1.1 % | 24.5 % |
| the 16 formats as configured | 1.4 % | **63.2 %** | 0.9 % | 32.5 % |
| dialed formats, dials neutralised | 6.8 % | **91.4 %** | 1.7 % | — |
| formats with no dials at all | −3.6 % | **84.0 %** | 0.5 % | — |

**Cause 2 (bench / availability) dominates: 63 % as configured, 84–91 % structurally.**
**Cause 1 (the PA curve) is −4 % to +7 %.** **Cause 3 (Pythagorean) is ~1 %.** The **dials** are
24–33 % on average and are deliberate — on `live-slots-weekly` and `gold-cap` they are the whole
story.

Cause 3's smallness is structural. Reallocating 20 runs between offence and defence at constant sum
moves E[win%] by **0.034 pp**; the map's curvature over ±20 runs costs **0.017 pp** against a linear
approximation. Both are an order of magnitude below the gaps being discussed.

### 3.3 The causal check — and why calibration will not close this

The `f0` sweep in *Read this first* is a causal manipulation, not a decomposition. Its shape matters:
the gap is **large across `f0` ∈ [0.2, 0.6]** and collapses only at **`f0` ≥ 0.8**. A second format
agrees: `bronze-cap-weekly` (dials neutralised) goes 0.4591 pp at `f0 = 0.6` → 0.0779 pp at
`f0 = 1.0`.

So "calibrate `f0` and the problem may dissolve" is **refuted by measurement**. The only regime where
the two formulas agree is the one where depth is nearly weightless — and §4.3 shows real teams use
depth *more* than either formula assumes. Calibration is still the right first move, because it fixes
numbers both formulas get wrong; it just will not make this go away.

---

## 4. Which ranker is better, and how would we know?

### 4.1 They are not independent models

The objective is not a rival theory of roster quality. It is the evaluator with three simplifications
applied for tractability — flat PA, a linear bench term, no Pythagorean map. Everything else (the
scoring core, ρ, exposure, the usage model, `pythExp`, `lgWoba`) is **common-mode**: shared, and
cancelling out of any comparison between them. Two consequences:

- "the objective might be right and the evaluator wrong" is not a well-formed position on the three
  disputed points. Nobody has ever argued that PA are uniform across lineup slots, or that a bench
  bat's worth is linear in its own value independent of whom it replaces. `roster-lp.ts` says as much.
- **But** agreeing with the evaluator does not make a roster better, because the evaluator's own
  parameters are unvalidated too — and §4.3 shows two of them are measurably wrong.

Also worth stating: **the evaluator is display-only.** `setExpectedWins` is reached from exactly two
places (`expectedWin`, `referenceD`) and feeds one line of `web/RosterPage.tsx`. It never enters
selection. So the practical question is not "is the printed number right" but "is the objective's
linearisation biasing what gets built" — and on the PA curve, demonstrably yes.

### 4.2 What could validate either ranker, and what exists

| candidate evidence | grain | verdict |
|---|---|---|
| `Tournament Data/` — 34 CSVs, 5 series | **card × team × running**; `ORG` groups 26 cards; `CID` joins **100 %** to the catalog; `ΣW`/`ΣL` per team; **realised `PA`/`BF`/`IP` per card** | **The only roster-grain asset in the project.** 1,628 team-runnings; 498 with a complete 26-card export. No placement column, no opponent identity, no game-by-game results. |
| `League Files/*ALL.csv` | player × 30-team AI-league season | Wrong population — 30–46-man AI clubs under different construction rules. |
| `League Files/* v{L,R} *`, `Model 2037 and 2038/` | player × platoon split | **`ΣW = ΣL = 0`** — no decisions recorded. |
| cwhit corpus (`src/eval/cwhit/`) | **card**, pooled over thousands of games | **No roster grain exists at all** — no team column, no W-L, no placement. |
| `data/` | config + fit artifacts + a little UI state | **No saved rosters, no results log, no history.** `/api/roster` recomputes and persists nothing. |
| simulation | — | **There is no game simulator anywhere.** `rotationStarts` is a rest-day scheduling LCG; `tournament-compare.ts`'s "head-to-head" is model-vs-model on per-card correlation. `setExpectedWins` is closed-form against an abstract .500 opponent and has no concept of an opposing roster. |
| `docs/` | design + per-card calibration | **No roster-level validation is claimed anywhere, and none has been done.** |

### 4.3 Head-to-head is out of reach; usage calibration is not

**Out of reach — and the limit is the corpus, not the filter.** Using realised wins as the outcome:
in an elimination format (`E[W] ≈ L·p/(1−p)`, L ≈ 4), a **+0.5 pp** change in per-game win
probability moves expected wins by **0.080**. Against the observed spread:

| completeness filter | n (team-runnings) | sd(W) | SE(mean W) | σ of the effect | n needed for 2σ |
|---|---|---|---|---|---|
| exactly 26 rows | 498 | 5.32 | 0.238 | **0.34** | 17,668 |
| ≥ 25 rows | 700 | 5.16 | 0.195 | 0.41 | 16,629 |
| ≥ 24 rows | 877 | 4.94 | 0.167 | 0.48 | 15,281 |
| ≥ 20 rows | 1,424 | 4.58 | 0.121 | 0.66 | 13,096 |
| **no filter at all** | **1,628** | 4.50 | 0.111 | **0.72** | **12,639** |

**This is the sample-size robustness check, and it comes out negative in the useful sense: loosening
the filter does not rescue it.** Even using every team-running in the corpus with no completeness
requirement, discrimination sits at 0.72σ. The binding constraint is that there are 34 tournament
exports, not that 70 % of teams are partially exported. A within-running matched design would buy
perhaps 1.5–2× in variance, not 8×.

*Caveats making even this optimistic:* the 0.5 pp effect size is the **evaluator's own estimate** of
the disagreement (circular — if the true difference is larger, power improves with its square);
opponent strength is uncontrolled; survivorship is severe (games played 4–43, winners play more);
and the completeness filter is plausibly correlated with outcome.

**So: nothing available validates either ranker's ordering. That is the most important sentence in
this document.**

**Not out of reach.** The same data validates the *shared usage model* — the layer where the
disagreement lives — because usage is observed directly, per card, hundreds of thousands of times.

Ranking each team's position players by the app's **own predicted hitter offence** (`hitOVR`, scored
under `early-gold`; exogenous to realised PA, so no sorting-on-noise bias), over 487 complete rosters:

| predicted-quality rank | measured share of team hitter PA | evaluator implies | objective implies |
|---|---|---|---|
| 1 | 8.06 % | 12.6 % | 11.1 % |
| 5 | 7.23 % | 11.1 % | 11.1 % |
| 9 | 6.93 % | 9.6 % | 11.1 % |
| 10–13 | 6.35 – 7.14 % each | (platoon second nine only) | 1.3 % each |
| 14 | 4.24 % | — | 1.3 % |

*(The model columns are orientation only — `lineupPA[k]/6200` and `benchPA/6200` — and assume the
model's rank-k seat is filled by the roster's rank-k hitter. The evaluator fields two platoon nines,
so its real implied profile is flatter than the column suggests. The like-for-like statistic is the
effective-N below, computed on a matched roster shape.)*

Three ordering-exogenous readings:

- **The flat-PA assumption is refuted.** Rank 1 takes **16.3 %** more PA than rank 9 (n = 487;
  **39.5 %** on the 76-roster exact-config Early Gold subset). The objective assumes 0 %.
- **The evaluator's slot curve is too steep, not too shallow.** It assumes 1.316:1 between the first
  and ninth batting slots. The measured gradient is **1.164** (all series) / **1.396** (Early Gold
  only); MLB's own leadoff-to-#9 PA ratio is ≈1.19. The truth is bracketed at roughly **1.16–1.40**;
  the objective's 1.00 sits outside that interval, the evaluator's 1.32 sits inside it near the top.
- **Both under-credit depth, and one cannot express the observed amount at any `f0`.** Effective
  number of hitters sharing team PA (inverse-Herfindahl; noise biases it *downward*, so this is
  conservative): **12.08 measured**. On a matched 14-hitter / 10-starter / 4-bench shape:

  | `f0` | evaluator-implied | objective-implied |
  |---|---|---|
  | 1.0 | 9.29 | — |
  | 0.6 (shipped) | 10.09 | 10.47 |
  | 0.4 | 10.46 | 10.91 |
  | 0.2 | 10.82 | 11.33 |
  | 0.0 | **11.15** | **11.70** |

  Neither reaches 12.08 even with every game missing a starter. (A roster with broader platooning —
  12 distinct starters — reaches 11.32 for the evaluator at `f0 = 0.6`, so the form is not hopeless,
  but the shortfall is real.)

One part of the usage model **passes**: measured top-reliever BF ÷ mean-reliever BF on the same 487
rosters is **2.05**; `bullpenLeverage = [2.5, 1.5]` over 7 arms implies **1.94**. A genuine,
previously-unmade empirical confirmation.

### 4.4 The three differences, assessed individually — detail is not accuracy

| difference | more *accurate*, or merely more *detailed*? |
|---|---|
| **Per-slot PA curve** | **More accurate in sign, over-stated in magnitude.** Declining PA down the order is a fact, measured here at 1.16–1.40:1, and `LineupTab.tsx` already seeds the batting order best-first — so the evaluator describes the lineup the app itself recommends, while the objective's flat curve is equivalent to assuming a **random** order. But 1.316 is ~2× the all-series estimate. |
| **Bench: leave-one-out re-match vs linear proxy** | **Structurally more accurate, numerically unvalidated.** Depth value is intrinsically marginal, and a per-card linear term cannot express a marginal. The evaluator's offence is a proper convex combination and conserves the 6200-PA budget; the objective's is not and over-credits by ~5 % (9×688.9 + 4×82.7 = 6531 — it prices playing time that does not exist). **But** the term is scaled by an uncalibrated `f0`, and both models under-credit real depth by ~1.6–2.0 effective hitters. Right *form*, wrong *scale*. |
| **Pythagorean nonlinearity** | **More detailed, correct, and irrelevant.** 0.017–0.034 pp — ~1 % of the gap. |

---

## 5. A cheap discriminating experiment

**Yes, for cause 1 — and it was run.** Two synthetic rosters, identical except for how value is
distributed across the nine starters: A has nine identical hitters, B the same *total* starter value
redistributed four-up / five-down (±0.020 wOBA). Bench, pitching, positions, cost, shape identical.

```
roster           Σ starter value   flat-PA offence   real-curve offence   evaluator offence
A  equal              0.1800            107.174            107.174             103.060
B  spread ±0.020      0.1800            107.174            114.481             109.718
```

The objective is **exactly indifferent** — not approximately, exactly, because its lineup term is
`avgPA × Σ value` and depends on the sum alone. The evaluator prefers B by **6.66 runs ≈ 0.42 pp**.
An independent fact about baseball settles it: the leadoff hitter bats more often than the ninth, and
the app's own Lineups tab already orders best-first. **On cause 1 the evaluator is right and the
objective is wrong, with no outcome data required.**

Two internal-consistency checks, both favouring the evaluator's *form*:

- **PA conservation.** The evaluator credits exactly the 6200 PA the usage model budgets. The
  objective credits 6531.
- **The app contradicts its own objective.** `LineupTab.tsx` seeds the batting order by score
  descending; the objective prices the roster as though the order were random.

**No discriminating experiment exists for cause 2**, which is 63–91 % of the gap. That is the honest
answer. The nearest thing is the usage calibration in §4.3 — which does not say which formula ranks
better, but does say what numbers both should be using, and (measured) that neither can currently
express the observed amount of depth.

**What does *not* discriminate:** the original nested-pool demonstration. It establishes disagreement
and nothing about direction. The exclude-one construction is strictly stronger on feasibility and
still says nothing about which side is right.

---

## 6. Options, with measured costs

| # | option | recovers | solve-time impact | risk | blast radius |
|---|---|---|---|---|---|
| **(a)** | **Carry the real per-slot PA curve in the objective** | **−4 % to +7 % of the gap. Measured on 4 formats: roster unchanged on 3; on `silver-cap` it traded 3 cards and the evaluator's own E[win%] fell 0.1123 pp.** | **~2× — measured: 1.66→2.69 s, 5.21→10.54 s, 6.43→11.76 s, 0.45→1.14 s** | Low correctness risk; **measured to deliver nothing** | `roster-lp.ts` + one option field; changes every cap/slots roster |
| **(b)** | **Generate K rosters, rescore with the evaluator, pick the winner — full pool** | Up to 100 % by construction | HiGHS-WASM exposes **no solution pool** (`highs` 1.14.2 `types.d.ts`: `solve(problem, options)` returns one solution; `mip_improving_solution_file` writes inside the WASM FS and is not surfaced), so K real solves. Median full-pool solve **0.6–18.4 s**; K = 26 → **16 s – 8 min**. Unaffordable | Requires believing the evaluator | Large |
| **(b′)** | **Same, on the `refineUpgrades`-style reduced pool** (roster ∪ top-60 by value ∪ 30 cheapest) | **Reproduces the full-pool optimum exactly** (verified: reduced-pool base objective == full-pool base objective on both formats tested). Gap found: 0.5806 vs 0.5815 full on `bronze-cap`; 0.3638 vs 0.2096 on `cwhit-cap` | **12–22× cheaper: median per-solve 5,003→407 ms and 1,645→74 ms.** 26 re-solves = **4–23 s** on top of the existing ~5 s solve → **~1.8× at K=10, ~3× at K=26** | Same belief problem; the reduction is validated here on 2 formats, not 16 | Large: changes which roster the user gets |
| **(c)** | **Accept and document** | 0 | 0 | The gap stays: median 0.10 pp as configured, up to 0.60 pp, ≈15–25 % of the local decision range on the formats where it bites. Silent | none |
| **(d)** | **Accept + tripwire** — a test asserting the MILP optimum also maximises `setExpectedWins` over the exclude-one neighbourhood, at a pinned tolerance | 0 pp, but the disagreement stops being invisible | ~5–25 s in CI on one fixture pool (the reduced pool makes it cheap) | Very low. It fails today, so it ships as a **characterisation** test with the current gap pinned | `tests/` only |
| **(e)** | **Calibrate the shared usage model against `Tournament Data/`** — `f0` first, then the lineup PA curve, then the bench share | Not a "recovery" — it moves *both* formulas toward measured truth. **Measured: it will not close the gap** (§3.3) | 0 at solve time; a few hours of analysis | Data is real but partial; ledger cleaning needed (`tournament-clean.ts` exists) | `expected-wins.ts` defaults + `ewinsInputs`; changes every cap/slots roster and every displayed E[win%] |
| (f) | Retire the E[win%] display | 0 | 0 | Removes the *symptom*. The objective still steers construction on a refuted flat-PA assumption, and the alarm is gone | `web/RosterPage.tsx`, `expectedWin` |

Note on (a): it was actually built — a continuous transportation block (cards → batting slots; the
assignment polytope is integral, so no new binaries: +3,048 rows, LP text 1.6 MB → 3.7 MB) — and
measured. The result is the strongest argument against it: it does exactly what it claims to the
objective and changes almost nothing about the roster, because cause 1 is a few percent of the
disagreement.

Note on (b′): this is the finding that changes the option landscape. Generate-then-rescore looked
unaffordable on full-pool solve times; on the reduced pool the project already uses in production it
is a ~2–3× cost, not 6–30×.

---

## 7. Pre-committed measurement design

Committed **before** anything is built.

### 7.1 Invariants (all options)

- **One server, one process, one `Dref`.** `referenceD` caches by tournament id from the *first*
  request's pool, so the anchor must be established once, up front, and every candidate scored
  against it. A comparison across two server runs is void.
- **Non-default port.** 8787 and 5173 stay untouched.
- **Both rosters re-scored, never one.** Report `E[win%]`, `offRunsAboveAvg`, `defRunsAboveAvg`, `Φ`,
  cost and the id set for both sides of every comparison.
- **Fixed pool**: same account, `ownedOnly`, excluded/locked sets, metric.
- **All 16 cap/slots formats, distribution not mean**, with dialed formats measured both ways.

### 7.2 If (e) — usage calibration — is chosen

1. **Dataset.** All `Tournament Data/**/*.csv`. Keep teams with exactly 26 `ORG` rows **and** passing
   the `tournament-clean.ts` PA–BF ledger. Record the exact n **before** fitting (expect ≈384–487).
   Pre-commit to reporting the ≥24-row and no-filter variants alongside, since §4.3 shows the filter
   costs a factor of ~3 in n.
2. **Estimand 1 — `fullStrengthShare`.** Share of team PA taken by cards outside the app's own two
   platoon nines for that roster (computed by running `bestLineup` on the real 26-card set), inverted
   through the evaluator's `(1−f0)/9` structure. **Adopt if the bootstrap 95 % CI excludes 0.6.**
3. **Estimand 2 — the lineup PA curve.** Per-card PA share on within-team predicted-quality rank,
   ordered by `hitOVR`, **never** by realised PA. **Adopt if the CI on the rank-1/rank-9 ratio
   excludes both 1.000 and 1.316.**
4. **Estimand 3 — effective breadth.** Inverse-Herfindahl of per-card PA; measured target 12.08.
   Pre-commit: if no `(f0, curve)` pair inside the evaluator's functional form reaches the measured
   breadth, that is a **finding about the form**, and it must be reported rather than fitted around.
5. **Hold-out.** Fit on `Return of the Bronze` + `Quicks - *`, validate on `Early Gold`. Pre-commit
   the direction of every estimate before looking at the hold-out.
6. **Success criterion.** Not "the gap shrank" — §3.3 predicts it will not, and using it as the
   target would invert the logic. Success = the recalibrated usage model's implied per-card PA
   profile beats the current one on the hold-out by mean absolute error across ranks 1–14.
   **Report the objective/evaluator gap before and after as an observation, explicitly not as the
   criterion.**
7. **A negative result is publishable.** If the fitted `f0` CI includes 0.6, that is the answer.

### 7.3 If (b′) — generate-then-rescore — is chosen

- **Primary metric.** Over all 16 formats: the exclude-one gap before and after, same instrument,
  same anchor, same pools. Pre-committed success: median gap **< 0.02 pp** and no format's gap
  increases.
- **Cost gate, pre-committed.** Median end-to-end generation ≤ **10 s** and p90 ≤ **20 s** across the
  16 formats, measured wall-clock at `/api/roster`. (b′) at K = 26 is projected to pass on the two
  formats measured (≈5 s + 4–23 s); this must be verified on all 16, not 2.
- **Reduced-pool exactness gate.** For every one of the 16 formats, assert the reduced-pool base
  objective equals the full-pool base objective. If any format fails, the reduction is unsound there
  and K must run on the full pool for that format.
- **Roster-churn report.** How many of the 26 cards change per format. Large churn with a small
  E[win%] movement is a warning, not a win: it means selection has become sensitive to a term whose
  scale §4.3 shows is wrong in both formulas.
- **Mandatory negative control.** Re-run the primary metric with `f0 = 1.0`. If the change only helps
  at `f0 = 0.6`, it is fitting an uncalibrated constant.
- **Mandatory second control.** Re-run with the *calibrated* `f0` from (e). Adopting (b′) before (e)
  means optimising a term at a scale we already know is wrong.

---

## 8. Recommendation

**A recommendation, not a decision.** The runtime trade — "spend ~2–3× the solve budget to optimise
the more detailed of two unvalidated models" — is an architecture call and belongs to the user.

**Do, in this order:**

1. **(d) Add the tripwire.** A characterisation test that solves a fixed fixture pool, builds the
   exclude-one neighbourhood on the reduced pool (cheap — 74–407 ms per solve), and asserts the gap
   stays within a pinned tolerance. No behaviour change; converts an invisible disagreement into a
   monitored one. Do this regardless of what else happens.
2. **(e) Calibrate the shared usage model against `Tournament Data/`, starting with `fullStrengthShare`.**
   63–91 % of the disagreement is the depth term; §3.3 shows one guessed constant controls it; §4.3
   shows that constant, the PA curve and the depth breadth are all measurable today from data the
   project already holds and has never used at this grain — and that the evaluator's form may not be
   able to express what the data shows, which is itself worth knowing. Go in expecting the gap to
   stay roughly where it is.
3. **Then decide on (b′), with the calibrated numbers in hand.** It is the only option that addresses
   the term that actually matters, and it is affordable (~1.8–3× the current solve, not 6–30×). But
   it optimises the evaluator, and the evaluator's ordering has never been validated — so this is the
   step where the user should knowingly choose "the more detailed model" over "the simpler one",
   rather than have it chosen by default.

**Do not:**

- **Do not adopt (a) on its own.** Built and measured: ~2× solve time, no roster change on 3 of 4
  formats, and on the fourth it moved 0.11 pp the wrong way by the evaluator's own reckoning.
- **Do not adopt (b) on full pools.** 16 s to 8 minutes per generation, and HiGHS-WASM cannot
  enumerate a solution pool, so every one of K is a full solve.
- **Do not "fix" the objective simply to make the two agree.** Agreement is not correctness. If the
  objective is made to match the evaluator, the tripwire goes quiet and the roster is still built on
  a depth model that real tournament data contradicts. Whatever is done, keep something that can
  still say the two disagree.

**And record the honest limit:** with at most 1,628 team-runnings against the ~12,600 needed, this
project **cannot** determine which of these two formulas ranks rosters better, and loosening the
completeness filter does not change that. What it *can* do — and should — is stop both of them from
using numbers that the data it already holds says are wrong.

---

## Appendix — reproduction

Nothing below is in the repo.

- Scratch repo: `<scratchpad>/probe-repo` (`src`/`web`/`data`/`fixtures` copied, `node_modules`
  junctioned), servers on `PORT=8911..8914`, `DATA_ROOT=data`.
- Probe endpoints added to the copy's `src/server/server.ts`:
  - `GET /api/debug/objgap?t=<id>&dials=on|off&f0=<x>&red=<N>&ownedOnly=<bool>&lock=<K>` — base
    solve, exclude-one neighbourhood, the six-rung ladder, one shared `Dref`; `red=N` switches to the
    reduced candidate pool and reports whether it reproduces the full-pool optimum.
  - `GET /api/debug/orderedpa?t=<id>&dials=on|off` — option (a): flat vs ordered-PA objective, LP
    size, build/solve times, both rosters scored on one `Dref`.
- Option (a) prototype: a continuous transportation block in `buildRosterLp` (`bo_<i>_<k>_v<S>`,
  `bolink_*`, `boslot_*`, plus a `Bounds` section) gated on a new `orderedPA?: number[]` option.
- Synthetic cause-1 discriminator: `<scratchpad>/synth.ts`.
- `Tournament Data/` analysis: plain Node over the CSVs, joining `CID` → catalog `Card ID` (100 %
  join, 3,704 base cards), with per-card `hitOVR` from `/api/cards?tournament=early-gold`.
- 19 probe runs (16 formats + 3 dials-neutralised) are in `<scratchpad>/out/*.json`; the `f0` sweep
  in `<scratchpad>/f0-*.json`; the reduced-pool runs in `<scratchpad>/red-*.json`.
