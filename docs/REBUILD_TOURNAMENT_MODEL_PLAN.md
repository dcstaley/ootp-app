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

**Next:** (1) strong-pool (Diamond ≤100) data would confirm gaps→0 ⇒ corrections→0 (the frame story
predicts it); (2) decide own-gap → opponent-gap production change (needs the channel map + envelope
semantics); (3) attack the K-channel attribution with a tournament-informed refit or a stu/kRat slope
recalibration; (4) re-check the 26-man top-26 impact once (2)+(3) land.
