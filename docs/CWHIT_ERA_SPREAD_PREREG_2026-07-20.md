# ERA-SPREAD FIT — PRE-REGISTRATION (2026-07-20)

Task 1 of the 2026-07-20 queue: fit a factor-conditioned spread scale `s(era_k)` for the pitcher
K channel, to remove the post-BUILD-1 residual (~1.44 at Early Gold / Bronze Heart).

**Status: PRE-REGISTERED, NOT FIT.** Written while blind to the outcome data — the captures have
not landed (cwhitstats down). Everything below is fixed before any fit is run. Per §15 gate
discipline, if a gate fails the leg is HELD; it is not re-tuned until it passes.

Nothing here changes production. No constant is proposed with a value.

---

## 1. The design matrix

Every candidate point, from `data/tournaments/*.json` + `data/eras/*.json` + `data/parks/*.json`.
`k`/`hr` are the era factor VALUES (the conditioning variables). Park columns are the raw factors
(all park factors are compressed by `cp` = 0.26 at scoring time; era factors are not).

| tournament | era | k | hr | park | park avg l/r | park hr l/r | park gap | cap | window |
|---|---|---|---|---|---|---|---|---|---|
| late-silver | 1929 | **0.288** | 0.563 | 208 | 0.97 / 1.01 | 0.84 / 0.77 | 0.922 | — | ≤79 |
| cwhit-cap | 1896 | **0.306** | 0.266 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | 1700 | 60–74 |
| early-gold | 1920 | **0.352** | 0.252 | 169 | 1.04 / 1.04 | 1.02 / 1.04 | 1.020 | — | ≤89 |
| wonky-slots | 1945 | 0.391 | 0.408 | 28 | 1.00 / 1.07 | 1.00 / 1.08 | 0.965 | slots | ≤89 |
| bronze-heart | 1939 | **0.411** | 0.584 | 191 | 0.97 / 0.97 | 1.15 / 0.66 | 0.980 | — | ≤69 |
| nightmare-cap | 1955 | 0.615 | 0.939 | 182 | 1.14 / 1.14 | 0.88 / 0.81 | 1.070 | 1559 | 50–74 |
| bronze-cap | 1955 | 0.615 | 0.939 | 155 | 1.02 / 0.98 | 1.05 / 1.13 | 1.088 | 1275 | ≤69 |
| golden-heart | 1977 | **0.727** | 0.910 | 129 | 0.99 / 0.98 | 0.88 / 0.92 | 1.021 | — | ≤89 |
| golden-childhood | 1984 | **0.757** | 0.811 | 153 | 0.99 / 1.01 | 1.20 / 1.07 | 1.007 | — | ≤89 |
| low-gold-retro | 1962 | **0.763** | 0.973 | 149 | 1.00 / 1.03 | 1.07 / 1.21 | 1.049 | — | ≤84 |
| gold-rush | 1989 | **0.799** | 0.772 | 123 | 0.91 / 0.84 | 0.94 / 0.91 | 0.969 | — | ≤89 |
| gold-sporer-sandlot | 1993 | 0.815 | 0.930 | 189 | 1.05 / 1.05 | 1.22 / 0.78 | 1.030 | 1858 | 60–89 |
| silver-cap | 1998 | 0.916 | 1.080 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | 1475 | ≤79 |
| bronze-quick | 2010 | **1.000** | 1.000 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | — | ≤69 |
| gold-quick | 2010 | **1.000** | 1.000 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | — | ≤89 |
| bronze-cap-weekly | 2010 | 1.000 | 1.000 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | 1331 | ≤69 |
| gold-cap | 2010 | 1.000 | 1.000 | **156** | **1.05 / 1.05** | **0.96 / 1.20** | **1.132** | 1580 | ≤89 |
| live-gold | 2019 | **1.241** | 1.455 | 7 | 1.02 / 0.99 | 0.97 / 1.01 | 0.944 | — | ≤89 |

**Bold `k`** = the uncapped/no-slots points that identify `s(era_k)` without a budget confound.

---

## 2. Identifiability — read this before fitting

### 2.1 PARK IS COLLINEAR WITH ERA across the entire capture set

*(superseded — see Amendment, item 1: the blanket claim below is false; `cwhit-cap` and `silver-cap`
are park-1.)*

Every non-2010 era point sits in a **different, non-neutral park**. Only the era-2010 formats use
neutral `park-1`. So in any naive fit, `s(era_k)` will absorb whatever park effect is present at
each era point. Park factors are compressed (`cp` 0.26) so the effect is damped — but it is
**card-dependent** where a park has a handedness split or a gap factor, and card-dependent effects
land on SPACING, which is exactly the axis being fit.

The worst offenders in the clean-era set are `bronze-heart` (park-191, hr_l 1.15 vs hr_r 0.66 — a
0.49 handedness split) and `late-silver` (park-208, gap 0.922). Both are load-bearing extreme-era
points.

**Consequence:** the fit must carry an explicit park term, or the residual must be shown to be
park-orthogonal. This is a pre-registered requirement, not a post-hoc option — see gate G0.
*(superseded — see Amendment, item 2: the requirement is channel-conditional, and an explicit park
term is now ruled out in both branches as unidentifiable.)*

### 2.2 The motivating gold-cap anomaly has an unruled-out PARK explanation

The BUILD-3 provenance comment in `src/model/pool-transform.ts` reasons about the gold-cap HR9
overshoot as follows: *"era factors are 1.0 there so it is NOT the era class."* That is true of
**era** and says nothing about **park**.

- `gold-quick` = era-2010, **park-1 (fully neutral)**
- `gold-cap` = era-2010, **park-156 (Fenway 1955): hr_l 0.964 / hr_r 1.199, gap 1.132**

The two formats in the pair that produced the flag differ by a park with a **0.235 HR handedness
split and the largest gap factor in the whole set**. The flag is on the **HR channel**. So the
"matched pair" `gold-cap` vs `gold-quick` does **not** isolate cap on/off — it is cap × park, and
the park differs precisely on the channel that flagged.

This does not refute the cap-composition hypothesis. It means the observation that motivated it is
**not yet evidence for it** over a park explanation. Task 2 must separate these before task 1
consumes any cap-format point.

### 2.3 Matched-pair audit

| pair | era | park | window | verdict |
|---|---|---|---|---|
| `bronze-cap-weekly` vs `bronze-quick` | 2010 = 2010 ✓ | 1 = 1 ✓ | ≤69 = ≤69 ✓ | **CLEAN** — the only uncontaminated cap on/off pair |
| `gold-cap` vs `gold-quick` | 2010 = 2010 ✓ | **156 vs 1 ✗** | ≤89 = ≤89 ✓ | **CONFOUNDED** by park (§2.2) |
| `nightmare-cap` vs `bronze-cap` | 1955 = 1955 ✓ | **182 vs 155 ✗** | **50–74 vs ≤69 ✗** | **DOUBLY CONFOUNDED** — park and eligibility window both move with tightness |

`bronze-cap-weekly` is therefore the single highest-value outstanding capture: it is the only
matched pair that isolates the budget variable cleanly. It should be prioritised above the
extreme-era P1 targets. *(superseded in part — see Amendment, item 5: `gold-slots` vs `gold-quick`
is a second clean budget pair.)*

The `nightmare-cap` vs `bronze-cap` "within-era tightness gradient" is weaker than the targets doc
implies: era is held, but park moves *and in opposing directions* (park-182 is high-average
/low-HR, park-155 is neutral-average/high-HR), and the eligibility windows differ (50–74 vs ≤69),
which itself changes pool composition — the very thing under test.

### 2.4 A hole in the middle of the curve

Clean uncapped `k` points cluster at **0.29–0.41** and **0.73–0.80**, plus the 1.000 anchor and
1.241 above it. There is **no clean uncapped point in k ≈ 0.42–0.72**. The only points in that
band (`nightmare-cap`, `bronze-cap`, both k = 0.615) are budget- and park-confounded.

This matters because the middle is exactly where candidate functional forms separate (§3).

---

## 3. Functional form — candidates, fixed in advance

Constraints from doctrine: `s` is a function of the era factor VALUE, continuous, and **`s(1) = 1`
exactly** (neutral era ⇒ no correction; the league frame is already calibrated in-frame). Named-era
special cases are mission-illegal.

Two candidates, both one-parameter, both satisfying `s(1) = 1`:

- **F1 (linear deficit):** `s(k) = 1 + B·(1 − k)`
- **F2 (power):** `s(k) = k^(−γ)`

A third, **F3:** `s(k) = 1 + B·(1 − k)^p`, is a two-parameter generalisation to be fit **only** if
F1 and F2 are both rejected — extra freedom is not bought without cause.

**These two are nearly indistinguishable on the extreme points alone.** Anchoring either to the
observed ~1.44 residual at k ≈ 0.35–0.41 implies B ≈ 0.68–0.75 and γ ≈ 0.35–0.41, and the two
curves then differ by only **≈ 0.07** across k ≈ 0.6–0.7 — the same order as a typical per-tier
spread CI. So:

> **Form discrimination is not achievable from the extreme-era points.** It rests entirely on the
> mid-era uncapped captures (`golden-heart`, `golden-childhood`, `low-gold-retro`, `gold-rush`) and
> on their CI widths. If those land thin, the honest outcome is to ship the simpler form (F1) and
> record that the form is unidentified — NOT to claim the fit discriminated.

`live-gold` (k = 1.241) is the only point above the anchor. It tests whether the correction is
**symmetric** — i.e. whether a high-offense era needs `s < 1` (compression) or whether the effect is
one-sided and `s` should be clamped to 1 for k > 1. This is pre-registered as a question, not an
assumption; the clamp is the default if `live-gold` gives no CI-clear signal.

---

## 4. Pre-registered gates

Held-out point is declared **before** fitting. Given the §2.4 hole, the held-out point must come
from the same band as the points it validates, so:

- **Held-out (primary): `gold-rush` (k = 0.799)** — mid-band, uncapped, and its park (park-123) is
  the mildest in the mid-era set (no handedness split; gap 0.969).
- **Held-out (secondary, extreme band): `bronze-heart` (k = 0.411)** — already in hand, and it is
  the extreme-band point whose residual motivated the task.

Fit on the remaining clean points; never on any cap/slots format for the era term.

| gate | requirement | fail ⇒ |
|---|---|---|
| **G0 — park orthogonality** *(superseded — see Amendment, item 2; **HR/BABIP limb CLOSED — see Amendment 2**)* | The fitted era residual must be uncorrelated with the point's park factors (avg, hr, hr-handedness split, gap), CI including 0; OR the model must carry an explicit park term and the era term must survive its inclusion CI-clear. | HOLD. Without this the fit is a park fit wearing an era label. |
| **G1 — held-out spread** | On `gold-rush`, predicted `s` must cover the measured K-spread calibration slope, and the post-correction spread ratio must move toward 1.0 **CI-clear** (paired bootstrap on the same cards, Δ excluding 0). Noise-deconvolved (dcv) throughout; never a raw ratio. | HOLD. |
| **G2 — extreme-band held-out** | Same on `bronze-heart`. | HOLD. |
| **G3 — no ordering regression** | On every scored format, no ordering metric (corr/Spearman/regret) may degrade CI-clear. Ordering-neutral is the requirement; ordering gain is not needed. | HOLD. |
| **G4 — level within bounds** | Post-correction levels must stay within currently accepted bounds. Uniform-within-role level movement is a convention (anchor-absorbed); **card-dependent** level movement is a spacing defect and fails this gate. | HOLD. |
| **G5 — anchor continuity** | `s(1.000)` must equal 1 to numerical tolerance, and the era-2010 formats' spread ratios must be **unchanged** by the correction. | HOLD — a correction that moves neutral-era formats is mis-specified. |
| **G6 — no budget leakage** | Refit excluding every cap/slots point must not move the fitted parameter CI-clear. | Indicates the era term is absorbing budget composition ⇒ HOLD pending task 2. |

Reporting is two-axis on every gate: **ordering and spacing both, always.** A spread-only or
ordering-only report is not a gate result.

## 5. era_hr — measure, do not assume

*(superseded — see **Amendment 2**. This section reads as though the HR fit were merely pending;
it is not. G0's HR/BABIP limb is CLOSED and `era_hr` is formally UNIDENTIFIED park-free. The
identifiability argument below is about the ERA DESIGN MATRIX — it shows K and HR are not
collinear across the era set, which remains true — and it says nothing about the PARK confound,
which is what actually blocks the channel. Do not read §5 alone as authorising an HR fit.)*

The queue says to check whether `era_hr` needs the same treatment and explicitly not to assume it.
Pre-registered: run the **identical** residual measurement on the HR channel against `era_hr`
values before proposing any form. Note the design already warns against transplanting the K result:
`era_hr` is far more dispersed than `era_k` at the low end (`early-gold` hr 0.252 and `cwhit-cap`
hr 0.266 vs `late-silver` 0.563 and `bronze-heart` 0.584 — a 2.3× spread among points whose `k`
values sit within 0.29–0.41 of each other), so K and HR are **not** collinear across the era set and
an HR term is separately identifiable. That is a reason to measure it, not a reason to expect it.

An `era_hr` term ships only on its own gate record; BUILD-3's HR ramp and any `s(era_hr)` must be
shown not to double-count the same amplification.

## 6. Wiring (only if gates pass)

Through the existing single-copy seam in `src/model/pool-transform.ts` alongside `kSpreadPitRamp` /
`pitSpreadHrRamp` — a factor-conditioned scale composed with the existing gap ramp, applied at the
same point in `score-card.ts` (raw model K, PRE-BIP PRE-ERA, so hits re-derive from corrected BIP
and `era_k` applies once). Universal, on-by-default, with a kill-switch state flag + `/api/training`
GET/POST pair, per §15.7. No per-tournament flag, no named-era branch.

## 7. Dependency

*(superseded — see Amendment, item 6: the ordering is relaxed to opportunistic.)*

Task 2 (cap/budget composition) **should run first**. §2.2 shows the anomaly motivating the cap
hypothesis is park-confounded, and §2.4 shows the era curve's middle is only reachable through
cap-confounded points. Until the budget effect is measured, either the mid-band stays empty or the
era fit silently absorbs a budget term (which G6 would catch, but catching it late wastes the
capture).

---

## AMENDMENT 2026-07-20 (post-review)

Rulings from review of the pre-registration above, recorded before any fit is run. The original text
is left intact; each item states what changed, why, and what it supersedes.

### Item 1 — §2.1 is factually wrong as written

**Superseded text:** "Every non-2010 era point sits in a **different, non-neutral park**. Only the
era-2010 formats use neutral `park-1`."

**Why:** false, and contradicted by the document's own design-matrix table three lines above it. Two
non-2010 era points are on neutral `park-1`:

| tournament | era | k | park | avg l/r | hr l/r | gap | cap |
|---|---|---|---|---|---|---|---|
| cwhit-cap | 1896 | 0.306 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | 1700 |
| silver-cap | 1998 | 0.916 | 1 | 1.00 / 1.00 | 1.00 / 1.00 | 1.000 | 1475 |

**Corrected claim:** park is strongly collinear with era, **not totally** collinear. Two era points
are park-clean.

**Binding qualifier:** both park-clean era points are **CAPPED**. They are park-clean but
**BUDGET-confounded**. `cwhit-cap` (k = 0.306) becomes usable as an era point only **after** the cap
effect is measured (task 2). This does not reopen §2.4 — the k ≈ 0.42–0.72 hole stands, since 0.306
and 0.916 both sit outside it.

### Item 2 — Gate G0 becomes CHANNEL-CONDITIONAL

**Superseded text:** G0 as written ("The fitted era residual must be uncorrelated with the point's
park factors … OR the model must carry an explicit park term"), plus the §2.1 Consequence line that
sets it up.

**Why:** the original G0 was channel-blind, and therefore over-engineered. Park factors carry
**avg / hr / gap ONLY**. There is no park K factor and no park BB factor anywhere — not in the Park
model, not in scoring-core (park is applied to HR, hits and XBH only), not in the sim. K is upstream
of BIP, so park cannot feed back into it.

**Amended G0:**

| channel | park requirement |
|---|---|
| **K** | none. `s(era_k)` is park-clean **BY CONSTRUCTION**. No park term, no park-matching. |
| **BB** | none. Park-clean by construction, same argument. |
| **HR / BABIP / gap** | park-neutral or park-matched data **IS required** for any era claim. |

Consequence for §2.1's named offenders: `bronze-heart`'s hr_l 1.15 / hr_r 0.66 split (0.49) and
`late-silver`'s gap 0.922 are **IRRELEVANT** to the K fit — which is the fit this document is for.
They remain live objections on the HR / BABIP / gap channels.

**In NEITHER branch do we carry an explicit park term.** We lack the design to identify one: there
are no two parks at a matched era anywhere in the set.

### Item 3 — Channel-basis corrections

From the covariance-decomposition work. The era fit's channel definitions are stated on this
corrected basis:

1. **SO/K is NOT a wOBA channel.** It carries zero weight in either composite and enters only
   through the BIP denominator.
2. **Predicted hitter 1B/XBH is identified FROM the composite identity.** Residuals on that cell are
   vacuous by construction. Its falsifiable check is `0 <= GAP <= nHH`.
3. **The pitcher basis is effectively 3-D.** Pitcher 1B/XBH are degenerate — both sides use a fixed
   0.25 XBH share, and the source table has no 1B/2B/3B split. Every pitcher cell therefore fails the
   positive-semidefinite check on that pair, and correlations there are **NOT measurements**.

### Item 4 — Multiple-comparisons policy (new; binding on this fit and generally)

The scorecard grid is ~50 cells (5 tiers × 5 channels × 2 roles). At 95% CIs, **~2.5 false CI-clears
are EXPECTED from noise alone.**

A CI-clear cell is therefore **not by itself a finding**. Before any cell becomes a work item it must
show either

- a **coherent shape** — monotone in gap, era, or tier; or
- **replication** in independent data.

### Item 5 — Capture / slots swap

| format | era | park | window | ruling |
|---|---|---|---|---|
| silver-slots | 2010 | **25** | ≤79 | **DEMOTED** for the general instrument — park-confounded against silver-quick. |
| gold-slots | 2010 | **1** | ≤89 | **PROMOTED** — pairs exactly with `gold-quick` (era, park, window all match). |

**Salvage note:** `silver-slots` remains usable for **K-CHANNEL-ONLY** slots reads, since park cannot
touch K (item 2).

**The clean budget pairs are therefore:**

| pair | isolates |
|---|---|
| `bronze-cap-weekly` ↔ `bronze-quick` | cap |
| `gold-slots` ↔ `gold-quick` | slots |

Together these two also separate **"budget-forced composition generally"** from **"cap-specific"** —
which neither pair does alone.

### Item 6 — §7 ordering relaxed to OPPORTUNISTIC

**Superseded text:** "Task 2 (cap/budget composition) **should run first**."

**Amended:** if an **UNCAPPED, NON-SLOTS** format at era k ≈ 0.45–0.70 is captured, it directly
identifies the era curve's gap region (§2.4), and **task 1 NO LONGER WAITS on task 2 for the K fit**.
Whichever identifying data lands first runs first.

**Task 2 remains REQUIRED regardless**, for three things:

1. the cap instrument itself;
2. promoting `nightmare-cap` and `bronze-cap` into the era fit as extra points;
3. unlocking `cwhit-cap` on the HR channel (item 1).

---

## AMENDMENT 2 — 2026-07-20 (G0 fallback invoked: era_hr UNIDENTIFIED park-free)

Amendment 1 item 2 made G0 channel-conditional: K and BB are park-clean by construction, but any
HR/BABIP-channel era claim requires park-neutral or park-matched data. It was then established that
**ZERO tournaments in the game are uncapped + park-neutral + non-modern** — the requirement is
unsatisfiable with data that can exist.

A within-format **handedness-contrast** route was proposed as an alternative identification strategy:
park HR factors are handedness-split, era factors are not, so an L-vs-R contrast inside one format
holds era, pool, budget and window constant by construction. It was accepted **only** conditional on
a mandatory dry-run against existing captures, with a pre-registered fallback if the dry-run failed.

**The dry-run failed.** Tool: `tools/park-hand-contrast.ts`, commit `176bf84`.

### 1. Dry-run results

**Pre-measurement verifications — all three resolved.**

1. `hr_l` / `hr_r` ARE batter-handedness (`src/scoring-core/helpers.ts:37-49`). The switch-hitter
   branch takes `hr_l` vs RHP and `hr_r` vs LHP — i.e. it follows the side batted from. A
   to-left-field reading could not flip with the PITCHER's hand.
2. `cp(p) = 1 + (p − 1)·0.26`.
3. Non-neutral env plumbing works.

**Measurements.**

| point | true contrast | measured Λ_net | 95% CI | verdict |
|---|---|---|---|---|
| Quick null (5 park-1 tiers) | **ZERO by construction** | **+0.079** | [+0.033, +0.128] | CI-clear ⇒ a REAL hand-correlated model bias exists |
| `early-gold` (near-null gate) | bounded ±0.014 under ANY compression | **−0.223** | [−0.354, −0.092] | CI-clear, **≈16× the bound** ⇒ **GATE FAILED** |
| `bronze-heart` (largest lever, dHr +0.490) | — | **−0.577** | [−0.756, −0.399] | exceeds even the fully-uncompressed prediction of −0.424 ⇒ **no compression in [0,4] solves it; physically inadmissible** |
| `gold-cap` (dHr −0.235, opposite sign) | — | implied compression **0.617** | [0.18, 1.08] | net CI **includes 0** ⇒ equally consistent with `cp` = 0.26 |

The near-null failure is the load-bearing one: the estimator carries a **FORMAT-SPECIFIC**
hand-correlated nuisance that is not park. Being per-format, the Quick null cannot absorb it.

**Pitchers are dead BY CONSTRUCTION.** Trained exposure has RHP facing 46.1% RHB and LHP 75.8%, so
the LHP−RHP contrast retains only **0.296** of the hitter contrast, **with the sign reversed**.

### 2. Ruling

1. **`era_hr` is formally UNIDENTIFIED PARK-FREE.** G0 is **CLOSED** for the HR and BABIP channels.
   An unpassable gate must not stand as if it might pass.
2. **G0 remains LIVE and unchanged for K and BB**, which are park-clean by construction (Amendment 1
   item 2). The era-K fit is unaffected by any of this.
3. **The one-cp structure is NEITHER falsified NOR confirmed.** This instrument cannot adjudicate it:
   the only physically admissible lever (`gold-cap`) is statistically consistent with `cp` = 0.26, and
   `bronze-heart`'s excursion is better read as evidence against the ESTIMATOR than against the model.
   **Do not cite the dry-run as evidence about `cp` in either direction.**
4. **Methodological trap, recorded for future readers.** In the mis-specified **ABSOLUTE** frame the
   two levers' implied compressions overlap tidily at **1.58** and **0.88** — a clean-looking "reality
   is uncompressed" answer. It is an artifact of netting a level-scaled null across formats whose mean
   ranges **4.2 to 17.2 HR600**. The scale-free **LOG** frame is the valid one, and the near-null gate
   is what exposed the mis-specification. The gate earned its place in the design.
5. The same handedness route was flagged as potentially extending to **BABIP** via park `avg_l`/`avg_r`
   splits (relevant to the parked Early Gold BABIP 1.50 question). That extension is **CLOSED** by the
   same failure — the demonstrated nuisance is not channel-specific.
