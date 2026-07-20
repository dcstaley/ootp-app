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
extreme-era P1 targets.

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
| **G0 — park orthogonality** | The fitted era residual must be uncorrelated with the point's park factors (avg, hr, hr-handedness split, gap), CI including 0; OR the model must carry an explicit park term and the era term must survive its inclusion CI-clear. | HOLD. Without this the fit is a park fit wearing an era label. |
| **G1 — held-out spread** | On `gold-rush`, predicted `s` must cover the measured K-spread calibration slope, and the post-correction spread ratio must move toward 1.0 **CI-clear** (paired bootstrap on the same cards, Δ excluding 0). Noise-deconvolved (dcv) throughout; never a raw ratio. | HOLD. |
| **G2 — extreme-band held-out** | Same on `bronze-heart`. | HOLD. |
| **G3 — no ordering regression** | On every scored format, no ordering metric (corr/Spearman/regret) may degrade CI-clear. Ordering-neutral is the requirement; ordering gain is not needed. | HOLD. |
| **G4 — level within bounds** | Post-correction levels must stay within currently accepted bounds. Uniform-within-role level movement is a convention (anchor-absorbed); **card-dependent** level movement is a spacing defect and fails this gate. | HOLD. |
| **G5 — anchor continuity** | `s(1.000)` must equal 1 to numerical tolerance, and the era-2010 formats' spread ratios must be **unchanged** by the correction. | HOLD — a correction that moves neutral-era formats is mis-specified. |
| **G6 — no budget leakage** | Refit excluding every cap/slots point must not move the fitted parameter CI-clear. | Indicates the era term is absorbing budget composition ⇒ HOLD pending task 2. |

Reporting is two-axis on every gate: **ordering and spacing both, always.** A spread-only or
ordering-only report is not a gate result.

## 5. era_hr — measure, do not assume

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

Task 2 (cap/budget composition) **should run first**. §2.2 shows the anomaly motivating the cap
hypothesis is park-confounded, and §2.4 shows the era curve's middle is only reachable through
cap-confounded points. Until the budget effect is measured, either the mid-band stays empty or the
era fit silently absorbs a budget term (which G6 would catch, but catching it late wastes the
capture).
