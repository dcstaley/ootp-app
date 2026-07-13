# Tournament-Specific Scoring Model — Plan

**Summary.** The app scores every card through one core: a `ratings → event-rate` curve (deployed
raw-poly hitting + StuffAug pitching) behind the `EventModel` seam, fed each side's ratings to produce
the grid's vL/vR scores. A "tournament-specific model" sounds like it means re-fitting that curve on
tournament outcomes — but tournament exports have **no vL/vR split**, and the thing that actually differs
between tournament formats is not talent, it's **how playing time is deployed across the two matchups**.
This doc reframes the tournament problem as **exposure/deployment estimation**, shows that an aggregate
format-level exposure parameter is recoverable from combined stat lines given the league curve, sizes the
data volume, and lands on a low-risk plan: **keep the league talent curves; make the platoon-exposure knob
`ρ` format-aware.** Builds on `REBUILD_PLATOON_EXPOSURE_PLAN.md` (Parts A/B) and the memory notes
`tournament-model-env-handling` + `platoon-exposure-plan` (Path-B ingest, one model structure, no per-hand
split model, exposure = pool baseline + trained deployment shift).

---

## 1. Problem

- **No split in the data.** Tournament outcome exports give a **single combined stat line per card** — no
  vL/vR breakdown. So we cannot directly observe a card's per-side rates from tournament play.
- **Platooning intensity varies by format.** Uncapped / no-slots tournaments are **heavily platooned**: a
  card may start **only vL** or **only vR** — a pure specialist. Capped tournaments platoon **less**: you
  maximize total card value, so your best cards play **both ways**. The same card produces a different
  combined line depending on the format's deployment norms, even with identical talent.

---

## 2. Key reframe — split the "split" into two components

Any observed combined performance is a blend of two independent things. Separate them:

- **Talent split** = `f(ratings_vR)` vs `f(ratings_vL)` — the intrinsic per-side skill. Comes from the
  league curve + the card's own vL/vR ratings. **Pool-invariant.** A no-split tournament dataset neither
  helps nor hurts it — **we already have it** from league training.
- **Exposure split** = how a card's PA divide across the two matchups `(w_R, w_L)`. Pure **deployment
  behavior**. **Highly format-dependent**: uncapped → weights near `{1, 0}` for specialists; capped →
  weights near the field average. **This is the only thing tournaments threaten.**

**Decision:** the tournament-specific thing worth learning is **not a talent curve** (we have it) — it's a
**deployment / exposure parameter per format**.

---

## 3. Identifiability

A combined line is `V_obs = w_R·(vR line) + w_L·(vL line)` with unknown weights: you observe the blend but
not the mix, so per-card exposure is not directly identified. **But** if you trust the league curve to
predict a card's true favorable-side and off-side rates `(fav, off)` from its ratings, then for a
specialist the exposure fraction `ρ` is **algebraically invertible** from the observed combined value:

```
ρ̂ = (V_obs − off) / (fav − off)
```

This is **well-conditioned exactly for high-gap specialists** (large `fav − off`) — the cards where `ρ`
actually matters — and **ill-conditioned for balanced cards** (`fav ≈ off`), where `ρ` doesn't matter
anyway (the denominator vanishes but so does the consequence). So an **aggregate, format-level `ρ`** may be
recoverable from combined data + the league curve, even though per-card exposure is not. How much data this
needs is being measured empirically — see §7.

---

## 4. The `ρ` knob already exists

`WinParams.platoonCapture` `ρ` (`src/eval/expected-wins.ts:35`, default `0.8`) is consumed in
`src/eval/offense.ts` and applied in `src/optimizer/assign.ts:66` as:

```
effectiveWoba = ρ·favorable + (1 − ρ)·off-side
```

Interpretation:
- `ρ → 1` = heavy platoon (**uncapped**: specialists get their favorable side).
- `ρ ≈ 0.6–0.75` = **capped** (the specialist edge shrinks toward the both-sides average).

Currently a **single global constant**. The concrete low-risk win: make **`ρ` (and the exposure baseline)
format-aware** — a per-tournament setting, eventually calibrated — **rather than training a new curve**.

---

## 5. Data-volume sizing

**Assumptions.** Single-elimination bracket, best-of-N per round, 9-inning games, ~38 PA per team per game
(≈ **76 PA = 76 BF** per game). Expected games per series: **BO5 = 4.13**, **BO7 = 5.81**. Series per
bracket: 128 teams → **127**, 64 teams → **63**.

**Per-tournament yield:**

| Format   | Games/tourney | PA (=BF)/tourney | % of a ~2.0M-PA league window |
| -------- | ------------- | ---------------- | ----------------------------- |
| 128 BO5  | ~525          | ~40,000          | ~2.0%                         |
| 128 BO7  | ~738          | ~56,000          | ~2.9%                         |
| 64 BO7   | ~366          | ~28,000          | ~1.4%                         |

**Tournaments needed** for three targets — **~200k PA** (minimal feasibility read), **~400k PA** (confident
initial read), **~2M PA** (league-parity / production):

| Format   | ~200k (min) | ~400k (confident) | ~2M (production) |
| -------- | ----------- | ----------------- | ---------------- |
| 128 BO5  | ~5          | ~10               | ~49              |
| 128 BO7  | ~4          | ~7                | ~35              |
| 64 BO7   | ~7          | ~14               | ~70              |

**Caveat — the tail is thin.** Per-**card** PA is small: an average team plays ~8 games → **~35 PA** for a
starting hitter per tournament. **But popular meta cards aggregate PA across the many rosters that use
them** — a card on 40 teams can clear **~1,000+ PA in a single tournament**. So a tournament fit is driven
by popular cards and weak on the tail — another reason to fit an **aggregate exposure correction**, not
per-card curves.

---

## 6. Recommended plan (3 steps)

1. **Treat tournaments as exposure/deployment estimation, not talent re-fitting.** Keep the league talent
   curves; do not re-fit `f(ratings)` on combined tournament lines.
2. **Make `ρ` + the exposure baseline format-aware.** Uncapped ≈ high `ρ`, capped ≈ lower `ρ`. Start as a
   **per-tournament-type setting**, calibrated later once §7 tells us how much data pins it.
3. **Before collecting any tournament data, run a synthetic re-deployment stress test on LEAGUE data** —
   where the true split is known. Re-deploy the same cards under specialist vs. both-sides exposure, blend
   to combined lines, and measure (a) how much exposure error actually costs in ranking/value, and (b) how
   much data pins `ρ` via the §3 inversion.

---

## 7. Model binding — native vs transfer (the unified neutral-frame design)

Two use cases must both work: **"this model is FOR tournament T"** (train on T, score T) and **"use this
OTHER model for tournament T"** (train on A, score T, T ≠ A). They are the SAME mechanism if you never
bake the environment in — **store every model in a neutral frame and always apply the TARGET tournament's
env at inference:**

```
score = neutralCurve(ratings) × era_T × park_T(hand) × poolTransform_T (+ exposure ρ)
```

- **Native (model for T):** the model was neutralized against T's own era/park → applying them back
  round-trips to the native environment.
- **Transfer (other model on T):** neutralized against A, inference applies T → A's neutral talent moved
  into T's environment. Same code path; only the env inputs differ.

**Bake-in is a trap** the moment you want transfer: you can't cleanly un-bake an entangled environment out
of a fitted curve (park handedness is inexpressible in it), so a baked model can only ever score its own
environment. Neutral storage is the price of admission for transfer, and it makes native free.

**Already built:** `scoreTournament` already does `neutralCurve × era × park × pool` for the *selected*
tournament using the active model's `eventForm`, and the league `eventForm` is already neutral. So the
INFERENCE side needs no new architecture. Two gaps: (1) **neutralize-on-ingest at train time** so a
tournament model's `eventForm` comes out neutral like the league one (divide each event rate by the same
per-channel factors inference re-applies, using the tournament's own era/park; park handedness handled
per-hand via known `Bats`, external to the curve); (2) a **per-tournament model binding**
`tournament.modelId ?? activeModelId ?? leagueModel` (same three-tier pattern the exposure layer uses).
Native vs transfer isn't a mode you pick — it falls out of whether the bound model was trained on this
tournament.

**Store BOTH fits (the §8 neutralize test motivates this).** Neutralize-then-reapply is NOT perfectly free
for native use: the empirical residual is **~2.5 wOBA pts at a chunky era (≈0.8 pt at a mild one)**, because
era adjusts BB/K/HR *before* BIP is computed, so the neutral hit curve is evaluated at an era-shifted BIP.
It's near-uniform (barely moves within-pool ranking, largely eaten by the 0.320 anchor) — but not zero. So:
**keep the RAW (bake) fit for native scoring (exact) and the NEUTRAL fit for transfer only.** Native
accuracy is then untouched by construction; transfer pays the neutralization + factor-accuracy cost, which
is unavoidable and validated separately (§8).

**Artifact carries:** the neutral `eventForm` (transfer) + a raw `eventForm` (native) + its
**training-env provenance** (the era/park id it was neutralized against, so native-vs-transfer is
auditable) + exposure/`ρ` + the pool reference frame. Transfer accuracy depends on the library era/park
factors being right; **native is exact regardless** (divide and re-multiply by the same numbers).

---

## 8. Empirical results — ρ sensitivity, recoverability & the neutralize round-trip (league stress tests)

Run `node tools/tournament-exposure-stress.ts` (league window 2040+2041; 156 paired hitters with both
sides ≥300 PA; deployed raw-poly curve). Two findings, both decisive.

**Setup.** vL/vR wOBA gaps across the 156 cards: **median 13 pts, p90 32 pts, max 76 pts**; 45 of 156 are
"specialists" (gap ≥ 20 pts). So most cards have a modest split and a real tail are strong platoon bats.

**A) ρ matters MODERATELY, concentrated in specialists.** A card's value swing from ρ=1.0 (uncapped) to
ρ=0.5 (no platoon) is exactly ½·gap — median **6.5 pts**, p90 **16 pts**. Ranking stability vs the ρ=1.0
reference:

| ρ (assumed) | Spearman vs ρ=1.0 | top-26 kept | top-100 kept |
|---|---|---|---|
| 0.9 | 0.997 | 25/26 | 99/100 |
| 0.8 | 0.986 | 25/26 | 97/100 |
| 0.7 | 0.968 | 23/26 | 95/100 |
| 0.6 | 0.946 | **21/26** | 94/100 |
| 0.5 | 0.918 | 20/26 | 91/100 |

Reading it: the **bulk ordering is stable** (Spearman ≥ 0.92 even at the extreme), but the **top-26 — the
roster-decision margin — reshuffles by ~5 cards** between an uncapped (ρ≈1) and a capped (ρ≈0.6)
assumption. The cards that move are exactly the high-gap specialists: e.g. a 76-pt specialist ranked #3 at
ρ=1.0 falls to **#51** at ρ=0.6; a 64-pt specialist drops rank 85→144. Balanced bats rise to fill their
slots. **Conclusion: getting per-format ρ wrong misranks the specialists at the roster margin — worth
setting per format, but it distorts *which* specialists make it, not the whole board.**

**B) The aggregate format ρ IS recoverable from no-split combined data.** Simulating combined lines at a
true ρ=0.85 with tournament-scale PA noise and inverting per card (ρ̂ = (V−off)/(fav−off), inverse-variance
weighted so the specialists carry it), Monte-Carlo over 400 sims:

| PA per card | total PA | ρ_recovered | 95% band |
|---|---|---|---|
| 100 | 16k | 0.847 | ±0.33 |
| 300 | 47k | 0.842 | ±0.19 |
| 1000 | 156k | 0.850 | **±0.10** |
| 3000 | 468k | 0.850 | ±0.06 |

The estimator is **essentially unbiased at every budget** — you do NOT need per-hand splits to pin a
format's deployment intensity; combined lines + the league curve suffice, because the specialists
self-identify through the curve. Precision is the only cost: **±0.10 on ρ at ~150k total hitter-PA, ±0.05
near ~470k.** Against the §5 sizing (~40k PA per 128-team BO5 tournament), that's a usable first ρ from
**~4–5 tournaments** and a tight ρ from **~10–12** — matching the §5 "initial read" band. (Real per-card PA
is uneven, but popular specialists aggregate PA across rosters, which is exactly where the gap-weighting
puts the signal.)

**Net:** the recommended path (§6) holds and is *better* than feared — keep the league talent curves, and
learn a per-format ρ from combined tournament data (unbiased, ~4–5 tournaments for a first estimate),
falling back to a format-heuristic ρ until then. `tools/tournament-exposure-stress.ts` is throwaway; the
numbers above are its output on the current league window.

### 8b. Does neutralize-on-ingest degrade a NATIVE model? (`tools/env-neutralize-check.ts`)

Fit a **bake** model (raw data, no env at inference) and a **neutralize(E)+reapply(E)** model on the same
league data treated as if collected in a non-neutral era E, then compare native scores — a wrong-or-right
factor must cancel for native use, so any gap is pure pipeline residual (no tournament data needed).

| test era E | native `|bake − neutralize+reapply|` (wOBA pts) |
|---|---|
| chunky (era_hr 1.12, era_bb 1.05, era_k 0.95, era_gap 1.08) | mean **2.53**, p90 3.26, max 3.69 |
| mild (era_hr 1.03, era_bb 1.01, …) | mean **0.80**, p90 0.96, max 1.04 |

- BB/K/HR/XBH cancel **exactly** (linear curves ÷F then ×F). The residual is entirely the **hit channel**:
  era adjusts BB/K/HR *before* BIP is computed, so the neutral hit curve is evaluated at an era-**shifted**
  BIP while it was fit on the neutral BIP. It **scales with |era−1|** (halving the era deltas ≈ thirds the
  residual) and vanishes at era=1 — confirming the mechanism, not a bug.
- It's **near-uniform** across cards, so it barely perturbs within-pool ranking and is largely absorbed by
  the 0.320 anchor — but it is **not zero**, and it is **independent of factor accuracy** (a wrong factor
  still cancels). Factor accuracy only bites on **transfer**, which needs real tournament data to validate.
- **Decision (feeds §7):** for **native** use, score the **raw (bake)** fit — exact, no residual; use the
  **neutral** fit **only for transfer**. Note the same era→BIP effect already exists when the *league*
  model scores a non-neutral tournament today — a known small approximation, not a tournament-only issue.

---

## 9. Open questions / next steps

- **Usage columns in exports?** Do tournament exports carry any per-card usage signal (games-started,
  PA-vs-hand proxies) that would give exposure **directly**, collapsing the §3 inversion problem?
- **Era double-application.** Verify era is **not double-applied** for a non-2010 tournament model — an open
  flag carried from `tournament-model-env-handling` (Path-B neutralize-on-ingest must divide out the same
  per-channel era+park factors inference re-applies, once and only once).
- **How to set/calibrate `ρ` per format.** Fixed per tournament type from field norms, calibrated from the
  §3 aggregate inversion once enough tournaments accrue, or a hybrid (prior = format default, updated as
  data arrives). Decide the resolution order and where the value lives in the tournament config.

---

## 10. Findings from real tournament data (2026-07-12) — the opponent-frame result

Validation against Early Gold (era-1920, ≤89, 7 runnings, ~280k PA) and Return of the Bronze
(era-2010, ≤69, 3 runnings), tools: `tournament-ptdiag.ts` / `tournament-cv.ts` / `tournament-role-k.ts` /
`league-bias-scan.ts`. All at ≥500 PA/BF, PA-weighted.

**10.1 The model is calibrated in its own frame.** On league holdout (2040+41, neutral env), per-event
level bias by rating quintile is ≤±3/600 everywhere (K-by-STU, BB-by-CON both flat). Tournament pool
ratings sit INSIDE the league's individual-rating range (league STU 50–187) — the old "own-rating
extrapolation" theory is dead. The cdmx catalog reference is fine (294 cards value-90s + 158 at 100+).

**10.2 Tournament bias is an OPPONENT-frame effect.** The curves predict a card's line **vs
league-average opposition**; in a weak pool everyone faces weak opposition. The correct first-order
re-basing is to shift each rating **additively by the OPPOSING channel's mean gap** (ref − pool), crossing
the matchup channels: `H.eye↔P.con` (BB), `H.kRat↔P.stu` (K), `H.pow↔P.hrr` (HR), `H.babip/gap↔P.pbabip`
(BIP). Tested on both tournaments, this collapses level bias: hitter events within ±4/600 in BOTH eras
(hitter K in Bronze: +37 raw → −3.6), pitcher BB +25→+7 (Bronze) / +10→+4 (EG). It also made all four
prior residual patterns quantitatively predictable in sign/size from the channel-gap asymmetries.
The production own-gap faded mean-scalar is directionally right (halves the bias — gaps are roughly
symmetric within a pool) but conceptually wrong: it lifts a rating by its OWN pool's gap where the
opponent's gap is what matters, and the two diverge in asymmetric pools (Bronze pitcher STU gap 47 vs
hitter kRat gap 19 → the big misses).

**10.3 The one surviving model defect: the K channel under-separates, both roles.** After frame
correction, predicted K spread by the K-channel rating is ~55–70 % of actual — in BOTH tournaments, BOTH
roles (pitcher K-by-STU AND hitter K-by-kRat), and WITHIN role (SP-only / RP-only splits reproduce it →
not a times-through-order mix artifact). League data faintly flags the same channels (AvoidK→K +1.11,
STU→K −0.68 residual-slope pts/SD — the two largest). Interpretation: in-frame calibration masks
attribution error via rating collinearity; out-of-frame pools expose it. This IS the long-open
"Stuff-residual" (over-rates low-Stuff/high-Control pitchers ⇔ under-separates K). It is a LEAGUE-model
defect visible in tournaments, not a tournament effect.

**10.4 Do we need native tournament models? No.** 5-fold-CV native fits win only with volume (EG
pitchers, 7 runnings: wOBA Pearson 0.67 vs league 0.57 — it learns the steeper K slope) and lose badly
thin (Bronze pitchers: 0.38 vs league 0.57). League + opp-gap frame beats native for EG hitters (0.86 vs
0.80). A league model with (a) opponent-gap frame correction and (b) a K-channel separation fix should
dominate native everywhere. Ranking nuance: the own-gap MULTIPLICATIVE transform accidentally helps
pitcher ranking (adds K-channel spread, masking 10.3); an additive opp-gap fix must land together with
the K fix or pitcher ranking may regress even as levels improve.

**10.5 Era-specific, separate — RESOLVED (2026-07-12, structural fix shipped):** EG 1B
over-prediction (+16 hitters / +22 pitchers) was neither BIP extrapolation (falsified: the fitted
H↔BIP elasticity ≈0.86/0.92 is genuinely identified; unit elasticity made it WORSE) nor pool
strength (≤1.5/600). Root cause: **era-factor semantics mismatch** — `era_avg` is a PER-PA hits
ratio but the derived `era_h` multiplies a PER-BIP quantity in the recompute (after BIP already
expanded under era_bb/era_k/era_hr), double-counting the era's BIP expansion. Library-wide: error
= the era's BIP ratio (dead-ball +18%; SIGN FLIPS for modern high-K eras, e.g. era-2019 ~−8% =
hits under-predicted). Fix: `resolveCoeffs` computes `era_h_bip = ((h−hr)/bip)_era / ((h−hr)/bip)_2010`
from the era's rates block; `computeDerived` prefers it (legacy per-PA path kept for rates-less
capture/synthetic configs). Validated: EG 1B bias +15.7→−4.1 (hit) / +23.0→+2.9 (pit), XBH
pitcher +11.4→+4.7; Bronze unchanged (reference era). Remaining EG XBH residual ≈+3 = the
dead-ball XBH-share gap (0.227 vs 0.249) — a separate, smaller era_gap-channel item.
**10.6 The blind HR 1.15/BB 0.85 default adjustment is mis-shaped:** measured biases are role-asymmetric
(post-frame hitter BB ≈ 0; pitcher BB +4..+7) — a symmetric era-multiplier can't express that; retire or
rebuild era/role-aware. **10.7 Correction:** the earlier "Bronze biases ≈ 0" note was wrong (confounded
run); raw Bronze biases are the largest measured.

**10.8 Frame correction v2 — the reference-basing discovery + K spread constant (2026-07-13,
`tools/tournament-kslope.ts`).** Two results that complete the transform design:
- **The reference frame was mis-based.** Gaps were computed vs the CATALOG TOP-50 field, but the
  model's true frame is its TRAINING opposition (PA/BF-weighted league means). Measured diff
  (ref − league): **hit.eye +16.0** (huge), hit.pow +7.7, pit.hrr +5.2, pit.stu +3.6, everything
  else ≤1.5. This exactly explains the "unfixable" pitcher-BB flat offset: both tournaments
  demanded a constant EXTRA CON shift of +16.4/+16.8 beyond the eye-channel opp-gap — i.e. λ→1
  once the reference is the training mean. Hitter BB / K levels looked calibrated all along
  because con/kRat/stu training means ≈ catalog-top-50 means. FIX: artifact stores per-channel
  `trainingMeans` (like ratingEnvelope); the opp-gap shift becomes
  `r + (μ_train_oppChannel − μ_pool_oppChannel)`, channel-crossed as in §10.2.
- **K spread scaling is a CONSTANT ~1.75, not gap-proportional.** Fitted s* (WLS, post-shift):
  EG·hit 1.75, BR·hit 1.72 (gaps 27 vs 47 — flat!), BR·pit 1.82; EG·pit 2.31 (outlier, dead-ball
  era_k or the then-mis-based level). Constant-s cross-validates (fit BR→EG: 1.03/0.81; fit
  EG→BR: 1.22/1.13 slope ratios from 0.46–0.60); linear-in-gap FAILS (overshoots to 2.05).
  Mechanism: `K_corr = K̄_pool + s·(K_pred − K̄_pool)` per role, s→1 in-frame. The RAMP shape
  (gap 0 → ~17) is unobservable with current data — the quicks ladder's gold/open points
  resolve it; conservative form s = 1 + 0.75·clamp(gap/17, 0, 1). DEPLOYMENT GATED on quicks.

**Next:** (1) implement frame-v2: `trainingMeans` on the artifact + training-mean-based opp-gap
shift + K spread scaling behind a transform-mode setting, re-fit s* with the corrected reference
(EG·pit 2.31 may normalize), validate levels+slopes on EG/Bronze; (2) quicks ladder when
available: gold/open pin the s ramp, low tiers (iron/bronze) cover the below-support K range —
deployment gate; (3) era_gap channel: run the era_h-style per-BIP/share semantics check (dead-ball
XBH share 0.227 vs 0.249); (4) re-check top-26 impact once (1) lands.

---

## 11. Build + resolutions — 2026-07-13 (this session)

Consolidated record of what was built, measured, and decided. Commits are on `main` (pushed).
Working detail also lives in memory `quicks-null-test-and-format-effect.md` /
`tournament-opponent-frame.md`; this section is the durable, version-controlled source.

**11.1 Frame-v2 SHIPPED** (`a5f4357`..`10c7fa1`). `trainingMeans` on the artifact (PA/BF-weighted
per-channel training-opponent means); additive channel-crossed opp-gap shift
`r + (μ_train_opp − μ_pool_opp)` + per-role K spread scaling `K_corr = K̄_pool + s·(K_pred − K̄_pool)`
(`S_K=1.75`, `G0_K=17`, provisional) behind `state.transformMode` (`own-gap` default | `frame-v2`).
`scoreCard` + `calibrate` apply both; K scaled PRE-era so `era_k` applies once. `K̄_pool` = top-50
field mean (my call, Derek deferred; revisit with quicks). Guard tests `tests/frame-v2.test.ts`.
kslope re-fit on the training-mean reference confirmed the mis-basing (`refF−TM`: hit.eye +15.9,
hit.pow +7.5, pit.stu +3.5, pit.hrr +5.3 — matches §10.8). **own-gap stays production default;
frame-v2 is quicks-gated.**

**11.2 era_gap per-share fix SHIPPED** (`27816dd`). `era_gap` was a per-PA XBH ratio but `woba.ts`
multiplies it onto `GAP_rate × BA_fin`, which already carries `era_h_bip` + the BIP expansion →
triple-count (same class as the `era_h` bug). Fix: `era_gap_share = ((b2+b3)/(h−hr))/2010` from the
rates block; `computeDerived` prefers it (legacy per-PA fallback for rates-less configs). Dead-ball
XBH over-prediction +4.6/600 removed; sign flips modern (era-2019 share 1.070). **Shifts library-era
XBH → regenerate affected tournaments (manual).** Guard `tests/era-gap-share.test.ts`.

**11.3 BIP-recompute audit — VALID + NECESSARY; one open item.** The BIP recompute is the VOLUME
channel (`era_bb/era_k/era_hr → BIP → hits`); freezing BIP mispredicts hits −22/+10 per 600 in
1920/2019. `era_h_bip` + `era_gap_share` FULLY reconciled the double-count (bit-exact at the 2010
reference). **Remaining (revises §10.5's attribution):** the FIXED `HIT_BIP_ADJ=5`/`PIT_BIP_ADJ=6`
constants don't adapt to dead-ball's ~24/600 HBP+SH+SF (vs ~10 at ref) → +2.65% hits/XBH in 1920,
~0 modern. This — NOT an XBH-share issue — is the true final EG XBH residual. OPTIONAL fix: era-aware
`BIP_ADJ` from the rates block (`1 − bb − k − hr − bip`), resolver pattern like the other two.
**SHIPPED (`4381d93`):** `era_bip_adj` scale (2010 → 1, 1920 → ~2.4, 2019 → ~0.9), `woba.ts`
multiplies `HIT_BIP_ADJ`/`PIT_BIP_ADJ` by it. Era-semantics trilogy complete. Shifts library-era
hit/XBH → regenerate.

**11.4 Open Quicks null test (5 runnings, era-2010 full-pool neutral).** (a) **FRAME STORY CONFIRMED:**
in-frame K-by-rating slope ratio ~1.0 (hitter 1.13 / pitcher 0.92) vs 0.4–0.6 in weak pools → the K
under-separation is a frame/opponent artifact that VANISHES in-frame. (b) **NEW universal FORMAT
effect** (deployment/TTO, orthogonal to pool strength): the model over-predicts offense — BB ×0.85,
HR ×0.87, non-HR hits ×0.96, pitcher K ~×1.03. Vindicates the retired `BB 0.85` default, REFUTES
`HR 1.15` (data says 0.87). **PROVISIONAL — HOLD, make NO changes** (Derek not convinced): 5 runnings
only; firm up with more Open runnings + tiers. Tiers double as a format-CONSISTENCY test (a true
format effect is ~constant across tiers after removing the frame correction). `tools/quicks-levelbias.ts`.

**11.5 K-slope defect RE-VERIFIED — real, not a ghost artifact, `s≈1.75` stands.** With all fixes
active and on ghost-CLEANED data: out-of-frame predicted K spread is still only 0.43–0.61 of actual;
`s*` = hitters 1.67–1.76, Bronze pitchers 1.83–1.84, EG pitchers ~2.34. Cleaning moves `s*` by ≤0.02
(NOT a ghost artifact — ghosts are 0.5–2.8% of rows, negligible in per-card aggregates; `s*` is a
slope statistic a few rows can't tilt). In-frame ~1.0. **Verdict:** defect real; `s≈1.75` a sound
central value, but a real role/tournament spread (hit ~1.7, pit ~1.8–2.3) means a FLAT constant
under-corrects EG pitchers → motivates the *fitted* opp-side curve over a hand-tuned constant.

**11.6 IBB.** Quicks 0.39 ≈ league 0.36; Bronze 1.23 (real, stable across runnings, FLAT across card
value → pool-wide level shift, not stud-concentration, not contamination); EG 2.38. EG > Bronze
despite a LOOSER cap → era-1920 is a genuine level add-on. Mechanism needs a cap-varied era-2010
tournament to separate cap from era.

**11.7 Ghost contamination — mechanism, detection, cleaning (all validated).** A manager who submits
no lineup is replaced by GHOSTS that play the (128-team, Bo7) bracket but DON'T export; the ghost's
real opponent plays 4 blowout games and carries a massively inflated combined line. The "scrub-cluster"
fingerprint is VOID (ghosts are invisible). DETECTORS that survive: (1) team-count shortfall
`N = expectedTeams − distinctORG`; (2) EXCESS-OFFENSE outlier `PA × (teamRate − poolRate)` (NOT raw
rate — raw false-positives on small-sample luck). SURGICAL CLEANING VALIDATED: remove the top-N
excess teams → pool converges to the clean baseline (Bronze Jul-7 138.2→136.4 H/600 vs clean Jul-11
135.2; flags Portsmouth Wunderfunk / DC Capital Giants — Derek's ground truth). Module
`src/eval/tournament-clean.ts` (`3a161db`) + `tools/clean-bronze.ts`. Cleaning IS possible here
because Bo7 ghost inflation is extreme + concentrated on one identifiable team. → the QA gate for
ingestion.

**11.8 Eval-only tournament ingestion** (`c05ed9d`). `src/training/tournament-eval.ts`: combined-line
loader (`TournamentObs` tagged `combined/evalOnly`, structurally isolated from training — distinct
type, no fit/window imports, guard test), `tournamentExposure`, `evaluateTournamentLevels`
(predicted-vs-actual per-600 level bias; predictions straight from the scoring core — one-core).
`GET /api/debug/tournament-eval?dir=&expectedTeams=` (ghost-cleaner via DI). Cross-role consistency
badge (`e8d092c`) on the tournament editor.

**11.9 Opp-side matchup-channel model — DESIGN + decisions** (`docs/REBUILD_MATCHUP_CHANNEL_PLAN.md`,
`38af66d`). Evaluate each channel at the matchup coordinate `x = own_rating − μ_opp` → native pool
re-basing that SUBSUMES frame-v2's shift + the KSpread patch. **Form A** = one shared shape `g(x)` +
per-role slope `a_role` (handles the item-4 shared-level/different-slope finding). **Key identity:**
opp-side trained on LEAGUE-ONLY ≡ frame-v2's additive shift (reparametrization) — same accuracy today,
cleaner architecture; the K-slope fix REQUIRES quicks because the steeper off-frame slope sits OUTSIDE
the league rating range (a data-support problem, not a structure problem). **Decisions (Derek):**
(1) build opp-side as the DEFAULT tournament model (not "frame-v2 as a disposable bridge");
(2) LEAGUE-PROTECTION GUARANTEE — the curve is `league_curve(x) + tail(x)` with `tail ≡ 0` inside
league support, so quicks fits ONLY the beyond-support tail → **league accuracy unchanged by
construction** (+ a hard league-RMSE gate as backstop); this is the KSpread structure *fitted* instead
of hand-tuned. **Phases:** 0 = scaffold now (Form A, `src/model/matchup.ts`, `transformMode:"matchup"`,
in-frame-equivalence + parity tests; league-only ⇒ = frame-v2, keep KSpread as the interim K patch);
1 = fit the tail on Bronze+Gold; 2 = full-ladder refit, retire KSpread → the fitted tail. **OPEN
DECISION:** an eval-only carve-out to *fit* the K SHAPE on quicks rows (argued as a structural matchup
constant, not per-card talent) — needs sign-off before Phase 1. **UPDATE:** Derek APPROVED both
(opp-side as default + the eval-only carve-out for the K-shape fit). **Phase 0 SHIPPED (`815ce9b`):**
`transformMode:"matchup"` binds the frame-v2 shift into the model (`makeMatchupModel`) with the
Phase-1 seams (`tail`, per-role `aRole`) pinned to identity + `kSpread` retained → **bit-identical to
frame-v2** (max per-card diff EXACTLY 0, proven in `tests/matchup.test.ts`), so league is untouched by
construction. Next: Phase 1 fits the `tail` on Bronze+Gold, protected by `league_curve + tail`
(tail ≡ 0 in-support) + a league-RMSE gate.

**11.12 Frame-v2 vs own-gap validation** (closes two handover open items; measured on EG + Bronze via
the current-code TM). (a) **Anchor is already a near-no-op in BOTH modes** (every scale ≤4% off 1.0 —
both level in rating-space before calibration); frame-v2 tightens it for EG (pitch 2.5%→1.2%), slightly
loosens for the deeper Bronze. So "frame-v2 → anchor no-op" holds, but it was already near-unit.
(b) **Top-26 moves substantially — SET and ORDER, not cosmetic.** own-gap vs frame-v2: top-26 kept =
EG hit 22/26, EG pit 22/26, Bronze hit 17/26, **Bronze pit 14/26** (Spearman 0.80/0.81/0.75/**0.64**).
So weak-pool pitchers see ~12 of the top-26 SWAP, driven by the saturated K-spread (`s=1.75`) stretching
the K axis (low-K contact arms fall, high-K rise). **Implications:** the default-flip is genuinely
roster-changing (so gating it on quicks is not pedantic); and the churn is driven by a FLAT `s`, while
pitchers actually want `s≈1.8–2.3` per §11.5 — the *fitted* opp-side tail captures that and de-risks the
exact margin that reshuffles.

**11.10 Quicks ladder.** Card values: Iron ≤59, Bronze ≤69, Silver ≤79, Gold ≤89, Diamond ≤99, Open =
none. All era-2010 neutral, Bo5 16-team. Frame-gap order (small→big): Open(~0) < Diamond < Gold <
Silver < Bronze < Iron. HAVE: Open (5 runnings). COMING: Bronze + Gold soonest (1–2 days), full ladder
~1 week. Recommendation was Diamond #1 (the unmeasured knee, gap ~5–12) / Gold #2; **Bronze + Gold is
ACCEPTABLE** — Open+Gold+Bronze in one format = the format-consistency test + a clean plateau
cross-check of the (ghost-touched) Bronze Return; Diamond deferred = the later knee-interior refinement
(ramp between gap 0 and ~18 assumed linear until then). Target 3–5 runnings/tier.

**11.11 Open decisions / next.**
- ~~Build opp-side Phase 0~~ — DONE (`815ce9b`). ~~Eval-only carve-out sign-off~~ — APPROVED.
- **Phase 1** (fit the K tail on Bronze+Gold quicks) — data-gated.
- **Format adjustment** (BB×0.85 / HR×0.87 / hits×0.96) — HOLD; firm up on more Open runnings + tiers.
- ~~`BIP_ADJ` era-aware~~ — SHIPPED (`4381d93`); era-semantics trilogy complete.
- **Buildable now (low-value):** (a) validate `evaluateTournamentLevels` IN-FRAME on the league ALL
  files (bias should ≈0 → confirms the combined-line pipeline before quicks); (b) realized-field /
  pool-μ measurement (§11.13); (c) cleanup bundle (log-linear/tHR/softcaps/SF+4 — SF+4 is the weakest,
  see §11.13; solo, conflicts with everything).
- **Derek manual actions:** retrain + activate a fresh model on current code (picks up `trainingMeans`
  + uBB + era_h/era_gap/era_bip_adj + the new form; clears the stale badge; makes frame-v2/matchup live
  on the toggle) — do it once HD452 (2042) lands so the 41–42 window is complete; regenerate rosters
  (era_gap + era_bip_adj shifted library-era hit/XBH scores).

**11.13 Post-shipping data state + newly-surfaced items (2026-07-13, late).**
- **Data state:** a temp 41–42 model was trained (throwaway; if trained on current code it carries
  `trainingMeans` → frame-v2/matchup are selectable via the Model-Training toggle). **HD452 (2042) is
  still missing** → the 41–42 window is partial until it lands. New combined **"ALL" league files**
  (`2042 {HD450,HD451,HD453,PEL} ALL.csv`, one line/card, NO vL/vR split — same format as tournament
  exports) — the per-side loader SKIPS them (`isCombinedLeagueFile`, `b3b0607`), preserved on disk.
- **ALL-data uses:** (1) validate the combined-line eval pipeline IN-FRAME — **DONE 2026-07-13:** on the
  2042 ALL files (active model `41-42-temp`), every event bias ≤ 0.9/600 (uBB −0.2/−0.4, K +0.8/+0.9,
  HR +0.2/−0.0, H−HR +0.5/+0.3) → the pipeline (exposure blend, combined-line aggregation, level table)
  is TRUSTWORTHY; safe to point `evaluateTournamentLevels` at quicks. Faint same-sign K over-pred (~0.8,
  both roles, under noise) = a faint in-frame K tendency, not an aggregation artifact. (2) realized-field
  measurement (below); (3) combined-league baseline for the format-effect work.
- **Realized-field / pool-μ — MEASURED 2026-07-13 (subagent):** the top-50 `μ_pool` proxy is
  SYSTEMATICALLY HIGHER than the usage-weighted realized field (a top-N selection effect: the best 50 sit
  above the PA-weighted mean), and the gap GROWS as the pool restricts — ALL-league Δ ≈ +2..+7, Quicks
  eye +16 / stu +11, Bronze pow +14.5, Early Gold pow +31.9. Meanwhile the realized field ≈ `trainingMeans`
  almost exactly in-frame (real−TM within ±1 ALL / ±4.5 Quicks), confirming **TM's usage-weighting is the
  right reference — the top-50 proxy is the weak leg.** So frame-v2's gap `μ_train (usage-wtd) − μ_pool
  (top-50)` uses INCONSISTENT weighting; power/eye/stu are the worst-biased channels, babip/gap track well.
  **CAUTION — the subagent's "under-correction, fix μ_pool" verdict is a FIELD-MEAN inference that is in
  TENSION with §10.8/§11.5: the kslope/ptdiag level-matching used this SAME top-50 μ_pool and the level
  bias DID collapse (≤±4). The shift is calibrated by LEVEL-MATCHING, not field-means, so the proxy may be
  operationally correct despite not equalling the realized field.** ACTIONABLE (Phase-1 prep, before the
  matchup fit which uses μ_pool): run a "matched-legs" check — recompute with consistent weighting (e.g.
  `trainingMeans` = top-50 of the training league, so the in-frame gap → 0) and RE-RUN the kslope/ptdiag
  level-matching. If levels still collapse → adopt the consistent version (removes the small in-frame
  spurious shift, elegant). If levels BREAK → the top-50 proxy was doing real work; keep it. The in-frame
  spurious shift (TM−proxy −4..−6 on eye/pow/stu in the ALL league) is the clean evidence of the
  inconsistency; its practical impact is tiny (anchor-absorbed) but it should be resolved before Phase 1.
  Note: this also touches `K̄_pool` centering (same top-50). Doubles as a ghost detector (contaminated
  running's realized field is anomalously weak vs the eligible catalog).
- **Hitter SF+4 — NOT a bug, refit-coupled cosmetic.** Hitter BIP_ADJ = HBP 6 + SH 3 − SF 4 = 5;
  pitcher = 6. Training (`forms/fit/bakeoff`) AND inference (`raw-poly`/`woba`/`HIT_BIP_ADJ`) use the
  IDENTICAL constant, so the fitted curve absorbs the convention and scores are correct (guarded by
  `raw-poly.test.ts` parity). "Fixing" = align the hitter/pitcher conventions + REFIT (scores
  ~unchanged); do it at a retrain if ever. The weakest cleanup-bundle item.
