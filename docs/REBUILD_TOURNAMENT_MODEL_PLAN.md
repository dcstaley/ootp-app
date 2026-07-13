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

> **⚠ AUDIT RETRACTION (2026-07-13, adversarial audit + ledger forensics — supersedes the "λ→1"
> claim in the bullet below; memory `tournament-opponent-frame` item 14).** The "λ→1 once the
> reference is the training mean" claim was a **SIGN ERROR** and is FALSE. The +16.4/+16.8 extra CON
> shift the tournaments demanded means the reference should be ~16 pts *HIGHER* than catalog top-50,
> NOT lower; the usage-mean coincidence (`refF − TM ≈ +16` on hit.eye) pointed the wrong way. λ→1 was
> asserted, never computed. Recomputed: under the usage-weighted TM the pitcher-uBB bias **DOUBLES**
> to +13/+17 (λ*≈3.8). The SHIPPED **matched-legs** frame (`μ_train` = top-50 of the training league,
> eye 120.3 ≈ catalog 123) accidentally restored **catalog-level basing** — that is what actually
> works, and it is a *relative* comparison, robust to data cleaning. A pitcher-uBB residual of
> **+6..+8/600 at λ=1 REMAINS OPEN** (λ* 1.65–2.7, NOT tournament-stable) — likely a genuine CON→BB
> channel residual (cf. league CON→BB +0.59), the BB-channel sibling of the K under-separation →
> **Phase-1 scope** (fit it as a BB-channel level/tail term with a per-tournament free level term).
> The K-spread result below SURVIVES the audit fully (see the retraction note on the second bullet).

- **The reference frame was mis-based.** Gaps were computed vs the CATALOG TOP-50 field, but the
  model's true frame is its TRAINING opposition (PA/BF-weighted league means). Measured diff
  (ref − league): **hit.eye +16.0** (huge), hit.pow +7.7, pit.hrr +5.2, pit.stu +3.6, everything
  else ≤1.5. ~~This exactly explains the "unfixable" pitcher-BB flat offset: both tournaments
  demanded a constant EXTRA CON shift of +16.4/+16.8 beyond the eye-channel opp-gap — i.e. λ→1
  once the reference is the training mean.~~ **[RETRACTED — sign error; see box above. The extra CON
  shift means the reference should be HIGHER, not the training mean; matched-legs (top-50 of training
  = catalog-level basing) is what shipped and works; +6..+8/600 pitcher-uBB remains OPEN.]** Hitter
  BB / K levels looked calibrated all along because con/kRat/stu training means ≈ catalog-top-50
  means. FIX (as shipped, `f88912c`): artifact stores per-channel `trainingMeans` = **top-50 of the
  training league** (matched to the top-50 pool μ); the opp-gap shift becomes
  `r + (μ_train_oppChannel − μ_pool_oppChannel)`, channel-crossed as in §10.2.
- **K spread scaling is a CONSTANT ~1.75, not gap-proportional.** Fitted s* (WLS, post-shift):
  EG·hit 1.75, BR·hit 1.72 (gaps 27 vs 47 — flat!), BR·pit 1.82; EG·pit 2.31 (outlier, dead-ball
  era_k or the then-mis-based level). Constant-s cross-validates (fit BR→EG: 1.03/0.81; fit
  EG→BR: 1.22/1.13 slope ratios from 0.46–0.60); linear-in-gap FAILS (overshoots to 2.05).
  Mechanism: `K_corr = K̄_pool + s·(K_pred − K̄_pool)` per role, s→1 in-frame. The RAMP shape
  (gap 0 → ~17) is unobservable with current data — the quicks ladder's gold/open points
  resolve it; conservative form s = 1 + 0.75·clamp(gap/17, 0, 1). DEPLOYMENT GATED on quicks.
  **[AUDIT 2026-07-13 — SURVIVES.** s* ≈ 1.67–2.0 is reference-robust across all frame permutations
  AND cleaning-robust (ghost-cleaned s* moves ≤0.02 — ghosts are 0.5–2.8% of rows, negligible in a
  slope statistic). The EG·pit 2.3–2.5 outlier PERSISTS unexplained, sitting atop an EG pitcher-K
  −10/600 dead-ball level residual. In-frame (Open Quicks) the slope ratio is ~1.0 → the defect is a
  frame artifact, not intrinsic. Mechanism + placement (pre-BIP, pre-era, once) verified correct.]**

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
effect** (deployment/TTO, orthogonal to pool strength): the model over-predicts offense — measured
level moves ≈ BB ×0.85, HR ×0.87, non-HR hits ×0.96, pitcher K ~×1.03.
> **⚠ LANGUAGE / FRAMING NOTE (Derek, 2026-07-13). These are MEASURED level moves, NOT a multiplier we
> plan to hardcode — and "0.85" is not a number the code should ever contain.** Two distinct things get
> conflated: (1) the OLD app's blanket `BB 0.85 / HR 1.15` adjustment — a hand-set fudge with no
> empirical basis, RETIRED (§10.6, explicit-field-only). (2) THIS measurement, which independently
> lands BB near 0.85 (coincidence with the retired value — do NOT read it as "the magic number was
> right") and REFUTES the old HR 1.15 (data says 0.87, opposite direction). The measurement is
> CONFOUNDED (realized-field ±3–4.5/600 + possible ghost inflation → a lower bound) and on 5 runnings.
> **End-state is NOT a global multiplier**: Phase 1 absorbs the format level via a per-tournament FREE
> LEVEL TERM fit from data (roadmap Batch 4.13), so each format gets its own fitted knob and no hand-set
> constant enters the code. Until then: **HOLD, make NO changes.**
Tiers double as a format-CONSISTENCY test (a true format effect is ~constant across tiers after removing
the frame correction). `tools/quicks-levelbias.ts`.

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

**11.7 Ghost contamination — mechanism, detection, cleaning.** A manager who submits no lineup is
replaced by GHOSTS that play the bracket but DON'T export; the ghost's real opponent carries a
massively inflated combined line. The "scrub-cluster" fingerprint is VOID (ghosts are invisible).

> **⚠ SUPERSEDED (2026-07-13, ledger forensics + roadmap Batch 1 — memory item 16).** The
> excess-offense detector `PA × (teamRate − poolRate)` and the `expectedTeams − distinctORG`
> team-count shortfall described below are **RETIRED**. Excess-offense TRUNCATES REAL WINNERS and
> manufactures a fake offense-suppression signal; distinct-ORG counting mis-reads multi-entry orgs
> (one ORG string fielding several teams). The decisive test is the **PA−BF LEDGER**: a complete
> export satisfies `ΣPA == ΣBF` exactly (Bronze July-11 = 0), so contamination = partial exports
> where an org carries `PA ≫ BF` and opens the pool ledger. **New detector**
> (`src/eval/tournament-clean.ts`, rewritten Batch 1): `|ΣPA − ΣBF| ≤ tol` ⇒ clean; else greedily
> remove the largest same-sign, `|asym| ≥ 0.10` orgs (asym = `(PA−BF)/(PA+BF)`) until the ledger
> reconciles (cleaned) or culprits exhaust (unreliable). Sign-matching + magnitude excludes small
> blown-out teams (Bronze July-7 Oslo Royals, −15.9% asym but opposite sign) and catches Portsmouth
> (13.7% asym, which a flat >15% rule misses). It reproduces the validated Bronze cleaning EXACTLY
> (DC Capital Giants, Portsmouth Wunderfunk) and runs on EVERY ingest. `tools/clean-tournament.ts`
> (generalizes `clean-bronze.ts`) produced **Early Gold − CLEANED** (all 7 runnings contaminated,
> ledger +228..+855 → residual ≤40; pool H/600 −1.5..−6.0). Per-dataset ledger status:
> **QUICKS clean** (ledger 0 ×5; the "shortfalls" were duplicate team NAMES, not ghosts — Derek
> confirmed 16 real teams in-game); **EARLY GOLD contaminated ×7** (partial exports); **BRONZE**
> cleaning validated. The old detail below is kept for provenance only.

~~DETECTORS that survive: (1) team-count shortfall `N = expectedTeams − distinctORG`; (2)
EXCESS-OFFENSE outlier `PA × (teamRate − poolRate)`.~~ SURGICAL CLEANING (old excess method): remove
the top-N excess teams → pool converges to the clean baseline (Bronze Jul-7 138.2→136.4 H/600 vs clean
Jul-11 135.2; flags Portsmouth Wunderfunk / DC Capital Giants — Derek's ground truth). This still
holds descriptively for Bronze (the ledger detector flags the same teams), but the ledger is the
name-independent, deterministic general test.

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
  **RESOLVED — matched-legs check RAN, verdict ADOPT, SHIPPED (`f88912c`).** Recomputed the frame with
  `μ_train` = top-50 of the training league (matched to `μ_pool`) and RE-RAN the kslope/ptdiag
  level-matching on ghost-cleaned EG+Bronze: (a) in-frame gap → identically 0 (was −3.6..−11.2);
  (b) out-of-frame level-matching HELD (no channel broke past its A baseline by more than ~2), and the
  worst residual — pitcher uBB — IMPROVED 11→6 (EG) / 14→8 (BR), ~5–6/600; (c) `s*` essentially
  unchanged (rose ~7–8%, same K story). So the field-mean argument and the level-matching AGREE (matched
  legs *correct* a real under-correction). `saveTrainedModel` now computes `trainingMeans` via
  `computeUnifiedFieldStats` over reconstructed training-league cards; env/softcap-independent selection,
  neutral coeffs. FORWARD-ONLY — existing artifacts keep usage-weighted means; takes effect at the next
  retrain. Tradeoff accepted: the clean in-frame identity + the pitcher-uBB fix outweigh ~2/600 hitter-K
  movement (both within the frame-v2/matchup path, not production own-gap).
- **Hitter SF+4 — NOT a bug, refit-coupled cosmetic.** Hitter BIP_ADJ = HBP 6 + SH 3 − SF 4 = 5;
  pitcher = 6. Training (`forms/fit/bakeoff`) AND inference (`raw-poly`/`woba`/`HIT_BIP_ADJ`) use the
  IDENTICAL constant, so the fitted curve absorbs the convention and scores are correct (guarded by
  `raw-poly.test.ts` parity). "Fixing" = align the hitter/pitcher conventions + REFIT (scores
  ~unchanged); do it at a retrain if ever. The weakest cleanup-bundle item.

**11.14 Batch-2 re-validation on GHOST-CLEANED data (2026-07-13, roadmap Batch 2).** Level tables
re-run on cleaned EG + cleaned Bronze through the CORRECTED eval (`evaluateTournamentLevels` now uses
the real BIP recompute + honors the active transformMode — was frozen-BIP + raw-base-model).

**RE-CONFIRMED on the retrained `league-41-42` model (2026-07-13, HD452/2042 added, full window).** All
numbers below (measured on the throwaway `41-42-temp`) reproduce within ~0.5/600 on the real model:
frame-v2 EG HIT H−HR +2.4 / PIT uBB +5.6 / PIT K −9.7; Bronze HIT H−HR +3.9 / PIT uBB +6.9. era_bip_adj
still KEEP (hitter |bias| 3.9→2.4, pitcher 7.7→5.7). Decisions transfer; roster regen is safe.


**IN-FRAME REGRESSION CHECK (2026-07-13) — PASS.** Before trusting the cleaned-data tables, the rewritten
eval was re-validated in-frame on the 2042 ALL-league combined files (full pool, neutral env = the
model's training frame, base frame): max |bias| = **0.89/600** (HIT uBB −0.19 / K +0.78 / HR +0.18 /
H−HR +0.45; PIT uBB −0.39 / K +0.89 / HR −0.04 / H−HR +0.27) — reproduces §11.13's frozen-BIP result to
~0.01. Expected: at neutral era the real recompute and frozen-BIP coincide (they diverge only on
non-neutral eras, where the fix matters). ⇒ the Batch-3.8 rewrite introduced NO in-frame regression; the
cleaned-data tables below rest on a proven-correct pipeline. (The faint +0.8 K over-pred both roles is
the known in-frame K tendency, not an aggregation artifact.)

`tools/tournament-levels-clean.ts`, active model `41-42-temp` (frame-v2). Per-600 level BIAS
(pred−actual), events uBB / K / HR / H−HR:

| | base HIT | base PIT | **frame-v2 HIT** | **frame-v2 PIT** |
|---|---|---|---|---|
| **EG (era-1920)** | +0.3 / +4.6 / −1.5 / −3.8 | +11.8 / −12.9 / +1.6 / +7.2 | **+6.6 / −4.2 / −1.0 / +2.3** | **+6.1 / −9.8 / +0.9 / +5.8** |
| **Bronze (era-2010)** | −6.8 / +36.1 / −4.8 / −11.0 | +25.3 / −17.2 / +6.0 / +6.4 | **+5.2 / −1.5 / −1.5 / +4.3** | **+7.6 / −3.9 / +1.2 / +4.1** |

**What moved vs the prior (contaminated / frozen-BIP) numbers:**
- **The frame story SURVIVES cleaning.** frame-v2 still collapses the raw opponent-frame bias:
  Bronze base HIT K **+36.1 → −1.5**, Bronze base PIT uBB **+25.3 → +7.6** (matches §10.2's "+37→−3.6",
  "+25→+7" — now on clean data). EG base PIT uBB +11.8 → +6.1.
- **The audit's EG level numbers WERE overstated by contamination.** The old "EG 1B over-prediction
  +15.7 → −4.1" (§10.5, on inflated actuals) is GONE: on cleaned data the frame-v2 hitter H−HR residual
  is only **+2.3** (mild over-pred). The dead-ball hit over-prediction the era trilogy targeted is small
  once ghosts are removed — but era_bip_adj still nets an improvement (§ era_bip_adj below).
- **The +6..+8/600 pitcher-uBB residual is CONFIRMED on clean data** (frame-v2: EG +6.1, Bronze +7.6) —
  the OPEN residual (§10.8 retraction), Phase-1 scope.
- **The EG·pit K −10/600 dead-ball level residual is real** (frame-v2 EG PIT K −9.8) and distinct from
  Bronze (−3.9) — the persistent EG·pit outlier (finding B).
- **Hitter uBB is now a positive ~+5–6.6 residual in frame-v2** (EG +6.6, Bronze +5.2) — the
  format/frame residual (BB channel), consistent with the held format effect (BB×0.85).

**era_bip_adj — MEASURED, KEEP (default unchanged).** `tools/era-bipadj-measure.ts`, cleaned EG,
era_bip_adj ON (resolved 2.398) vs OFF (=1), read in the PRODUCTION frame-v2:
- **Hitter H−HR residual: OFF +3.85 → ON +2.32** (|bias| ↓ 1.53). **Pitcher H−HR: OFF +7.81 → ON +5.77**
  (|bias| ↓ 2.04). ON reduces BOTH — the keep rule ("reduce hit+XBH residual without worsening the
  pitcher chain") is satisfied; era_bip_adj IMPROVES the pitcher chain, it doesn't worsen it.
- The audit's "−0.3..−1.9% pitcher hit push" is real (measured −1.4%, 147.4→145.3) but BENEFICIAL on
  clean data (pitchers over-predict, so pushing down helps). The base-frame view (where OFF looked
  better for hitters) is confounded by the uncorrected opponent-frame bias (weak-pool hitter
  UNDER-prediction) — not the frame production scores in. **Decision: KEEP; default not reverted;
  machinery + `era-bip-adj.test.ts` retained.** Safe for roster regeneration.

**11.15 Transform-mode LIFECYCLE + the validation scorecard (design constraint, Derek 2026-07-13).**
The three transform modes are NOT a permanent menu — they collapse post-Phase-1:
- **own-gap** (multiplicative faded-scalar) → **RETIRE.** The only genuinely different mode; the
  predictive scorecard (below) is the evidence gate to pull it (expect matchup ≥ frame-v2 > own-gap on
  Spearman / value-regret).
- **frame-v2** → **FOLDS INTO matchup.** frame-v2 IS matchup-with-`tail`≡0 (Phase-0 bit-identity), so
  it's not a separate mode once the tail is fit — it's "matchup before Phase 1." No risky swap.
- **matchup** (opp-side, fitted tail) → the SINGLE surviving transform + production default.
- **Sunset cleanup (tracked, do at Phase 2):** remove the own-gap `poolTransform` machinery, the
  frame-v2 `kSpread` interim patch (replaced by the fitted tail), the UI toggle's dead options, and the
  `scoreTournament` per-mode branches. A real chunk of dead code — remove it, don't leave it behind a
  collapsed toggle.

**Validation panel = a PREDICTIVE SCORECARD, not a level-bias table** (Derek's point: level bias is
calibration, not discrimination; the K under-separation is a pure ranking defect INVISIBLE to level
bias). Per tournament × role × mode, on the FINAL scored wOBA (era/park/frame/calibration applied) vs
realized wOBA (same artifact wOBA weights): **Pearson r, Spearman ρ (the roster metric), RMSE, spread
ratio (SD_pred/SD_actual — exposes under-separation per-tournament), value-regret / top-N overlap (the
roster-honest metric), + level bias as the calibration row.** Machinery already exists (bake-off
scoreboard = weighted Pearson + value-regret + CV; `tournament-cv.ts` = native-CV Pearson) — surface it
per tournament. **BUILD MODE-AGNOSTIC:** the mode axis is DATA-DRIVEN (render whatever modes the backend
reports; loop generically), NEVER a hardcoded own-gap/frame-v2 pair — so it survives the sunset with
zero rewrite and doubles as the retirement gate.

**11.16 SCORECARD SHIPPED — first result: frame-v2 REGRESSES ranking despite fixing calibration
(2026-07-13, `tools/tournament-scorecard.ts` + `tournamentScorecard`).** Per-card predicted-vs-realized
RAW wOBA on ghost-cleaned EG + Bronze, active model `league-41-42`. **Spearman ρ (the roster/ranking
metric)** by role × mode:

| cell | base | own-gap | frame-v2 |
|---|---|---|---|
| EG·hit | 0.53 | 0.51 | **0.59** ← frame-v2 wins |
| EG·pit | 0.64 | 0.64 | 0.61 |
| BR·hit | 0.65 | 0.57 | 0.53 |
| BR·pit | 0.63 | **0.68** | 0.46 ← frame-v2 much worse |

**RMSE + level bias UNIFORMLY favor the transforms** (own-gap/frame-v2 ≪ base — calibration improves),
but **Spearman + value-regret tell the roster story**: frame-v2 improves ranking ONLY for EG hitters; for
PITCHERS (both eras) and Bronze hitters it ranks WORSE than own-gap — starkly for BR·pit (own-gap 0.68 vs
frame-v2 0.46). value-regret agrees (own-gap ≤ frame-v2 on BR·pit .007 vs .011, EG·hit). The spread-ratio
row shows the mechanism: frame-v2's flat `S_K=1.75` K-spread distorts the wOBA spread (EG·hit 0.65 vs base
0.96). **This QUANTITATIVELY CONFIRMS the long-standing prediction (§10.4 / memory item 4): the additive
opp-gap shift without the K-slope fix REGRESSES pitcher ranking even as it fixes levels.** Implications:
(1) **for roster generation TODAY, own-gap likely ranks pitchers better than frame-v2** — frame-v2's level
win does not translate to roster value; (2) **do NOT sunset own-gap on level bias** — the sunset gate is
the scorecard showing matchup-with-fitted-tail beating own-gap on Spearman/value-regret, which frame-v2
alone does NOT clear; (3) it's the empirical case FOR Phase 1 (the fitted tail must land to make the
opp-side frame a ranking improvement). CAVEATS: small N (61–115 cards), combined lines, per-card realized
noise → the ~0.03–0.05 gaps are within noise, but BR·pit's 0.22 gap is large and directionally consistent
with the prior finding. The scorecard is now the standing instrument for every future frame/model change.

**11.17 QUICKS LADDER measured — the K-ramp + format effect (2026-07-13, `tools/quicks-ladder.ts`).**
Open + Bronze + Gold quicks in (7 / 7 / 5 runnings, era-2010 neutral, ghost-cleaned in-memory — Open+Bronze
ledger 0; one Gold ghost auto-removed). Active model `league-41-42`. **This is the Phase-1 fit data.**

**(A) The K-slope RAMP is now observed** — `s*` (K spread the data wants, WLS centered on production K̄_pool):

| tier | hit gap | pit gap | s* hit | s* pit |
|---|---|---|---|---|
| **Open** (val≤∞) | 0.1 | 5.6 | **0.99** | 1.28 |
| **Bronze** (≤69) | 42.3 | 25.8 | 1.71 | 1.64 |
| **Gold** (≤89) | 26.1 | 22.3 | 1.72 | 2.06 |

**Open in-frame `s* hit = 0.99 ≈ 1.0` — the previously-UNOBSERVABLE ramp base (§10.8) is now pinned.** The
frame story is fully confirmed: in-frame the K spread is correct; out-of-frame the model under-separates and
`s*` ramps to ~1.7 (hit) / ~1.6–2.1 (pit). Hitters plateau ~1.71 by gap ~26 (flat 26→42); pitchers want
HIGHER (~1.6–2.1, role split confirmed). The hand-tuned `1 + 0.75·clamp(gap/17)` (→1.75) is roughly right for
hitters but under-shoots pit. **The fitted tail now has real anchors: s→1 at gap 0 (Open), s≈1.7 hit / ~1.9
pit at the Bronze/Gold gaps.**

**(B) Format effect confirmed IN-FRAME (Open, gap≈0 → pure format, no frame artifact), now on 7 runnings:**
hitter uBB **+8.3**, K +2.5, HR +0.9, H−HR **+3.5**; pitcher uBB +5.4, K −0.6, H−HR +3.5. The model
over-predicts offense by a roughly constant format amount — BB most (~+6–8/600 ⇒ the held ~×0.85), hits
mild (~+3.5 ⇒ ~×0.975), HR ~flat, K slightly over. Frame-corrected uBB stays +7..+11 across all three tiers
(same sign/scale ⇒ a real format level, not a frame artifact that scales with gap). **This is still the
per-tournament FREE LEVEL TERM's job (§11.4) — not a hardcoded multiplier.**

**(C) Discrimination (scorecard) confirms the flat kSpread under-serves pitchers:** frame-v2's pit spread
ratio stays 0.29–0.53 (still under-separated even with s=1.75 — because pit wants ~2.0), and pit Spearman is
mixed (frame-v2 hurts Bronze pit 0.41 vs own 0.52, helps Gold pit 0.53 vs 0.47). Hitter value-regret is
consistently LOWER under frame-v2 (Open .006 vs .009, Gold .007 vs .013). **⇒ the FITTED per-role tail (pit
s≈2.0) is what makes the opp-side frame a ranking win; the flat constant doesn't get there.** Small N
(Spearman over 19–31 cards/tier — noisy; the s* slopes over more cards are the robust part).

**Phase-1 READY.** The ladder gives: the ramp anchors (A), the format level to absorb with free knobs (B),
and the discrimination gate the fitted tail must beat (C). Next: fit `tail`+`aRole` on matchup's seam
(Open anchors s→1, Bronze/Gold the plateau, per role) + the pitcher-uBB BB-channel term, league-RMSE-gated.

**11.17b Statistical power — the quicks are a strong FIT instrument, a WEAK RANKING instrument
(`tools/quicks-power.ts`).** Measured per-card realized-wOBA SPREAD (talent) vs per-card sampling NOISE
(∝1/√PA) → signal-to-noise for per-card ranking: Open HIT S/N **0.44**, Bronze HIT 0.62, Gold HIT 1.02;
Open PIT 1.32, Bronze PIT **≈0.01** (talent ≈ noise — cards indistinguishable), Gold PIT 0.52. **The
talent spread within a value-capped pool is COMPARABLE TO OR SMALLER THAN the measurement noise** — a
RANGE-RESTRICTION floor, NOT a sample-size problem. To lift Open HIT to S/N 2 needs ~×20 runnings (~145
total); Bronze PIT is unreachable (signal≈0). **⇒ (1) The per-card Spearman/value-regret on quicks is,
and will stay, NOISY — the quicks validate the model's SLOPE/CALIBRATION, not fine within-pool ranking;
don't over-read the scorecard's ranking cells on capped tiers. (2) The FIT does NOT need this — `s*` is an
aggregate slope over the whole swept RATING range (strong signal), so the ramp (A) is robust on current
data. (3) value-regret stays small precisely because the cards are close (roster COST of a ranking error
is low) — comforting for roster-building. Recommendation: FIT NOW (≥7/tier is plenty for the slope; +3–5
Gold to firm the noisier pit plateau); do NOT wait for ranking confidence that capped quicks can't
provide; use Open / wider-value pools when ranking IS the question.**

**⚠ CORRECTION (2026-07-13, `tools/quicks-rank-check.ts` — Derek pushed back on "cards are close").**
The "talent ≈ noise / cards indistinguishable" read above was an OVER-READ: it came from a fragile
de-noising (spread² − noise² → ~0) applied to the range-restricted HIGH-PA ELITE subset (≥300–500 PA
selects the most-played staples, a narrow top band; spread shrinks as the threshold rises). Over the
FULL played pool (≥100 PA, N≈52–71 cards/tier) the model's OFFENSIVE ranking is a REAL, moderate signal,
NOT noise: own-gap Spearman ρ — Gold HIT **~0.50** (stable across thresholds), Bronze PIT 0.39→0.57,
Bronze HIT ~0.30, Open ~0.20 (Open is the WEAKEST — its played pool is elite-only = narrowest band; the
CAPPED tiers have the WIDER played-value band and rank BETTER). So: **the cards are NOT close** — a
value-88 card really does out-produce a value-55 card and the model tracks that (ρ~0.5 where the band is
wide + PA decent). The honest limits are (i) MODERATE not crisp correlation (per-card noise + we only
observe OFFENSE, not defense/position/two-way, which the app's full card VALUE includes and tournament
stat lines cannot validate), and (ii) fine ranking WITHIN a narrow elite band stays noise-limited. More
runnings DO help the full-pool estimate (tightens ρ, adds cards); the earlier pessimism was the wrong
(elite-subset) lens. NOTE the scorecard's predicted wOBA already INCLUDES the rating scaling (fitted
curves + env + pool/frame transform); it EXCLUDES only the anchor (a global scale, irrelevant to rank)
and non-offensive value (unmeasurable here).

**11.18 PER-CHANNEL off-frame separation (`tools/quicks-channels.ts`) — it IS mostly a K thing, and
StuffAug's HR term looks needed.** s* (spread scale the data wants, after the opp-gap level shift, no
per-channel spread correction) per tier × role × channel:

| | BB | K | HR | H−HR |
|---|---|---|---|---|
| Open HIT (in-frame) | 1.06 | **1.00** | 0.81 | 0.89 |
| Open PIT (~in-frame) | 0.80 | 1.35 | 0.56 | 1.09 |
| Bronze HIT | 1.13 | **1.71** | 1.14 | 1.82 |
| Bronze PIT | 1.91 | **1.80** | 1.05 | 2.00 |
| Gold HIT | 1.11 | **1.71** | 1.08 | 1.50 |
| Gold PIT | 0.80 | **2.10** | 1.46 | 1.21 |

**Findings** (N 19–31/cell — directions solid, values noisy): (1) **K under-separates strongly off-frame
in BOTH roles** (1.7–2.1) and is ≈1.0 in-frame (Open HIT K = 1.00) — the tail is really a **K thing**.
(2) **HR is basically FINE off-frame** (≈1.0–1.1, hit and pit) — un-augmented K under-separates but
Stuff-augmented HR does NOT ⇒ **StuffAug's HR-Stuff term looks like it's WORKING; evidence to KEEP it,
not remove it** at the opp-side switch. (3) **BB's issue is LEVEL, not spread** — the spread s* is mild
and INCONSISTENT (pit 1.91 Bronze vs 0.80 Gold) while the level bias is a stable +7..+10 (pitcher) — so
the planned **pitcher-uBB LEVEL term** handles BB, not a BB spread tail; StuffAug's BB-Stuff term is
ambiguous (doesn't fix the level, spread unclear) → re-examine at the re-fit. (4) **H−HR (hits)
under-separates (1.5–2.0) but largely DOWNSTREAM of K via BIP** (BIP = 600−BB−K−HR−adj; a too-narrow K
spread compresses the BIP→hits spread) ⇒ fixing the K tail should tighten hits too; likely **no
independent hit tail**. **Net: Phase 1 = K tail (both roles) + pitcher-uBB level term — CONFIRMED and
SIMPLER than per-channel tails; HR needs nothing (StuffAug covers it), hits follow from K, BB is level.**

**11.19 PHASE-1 REVISED after Fable's pressure-test — VERIFIED, adopted (2026-07-13, `tools/matchup-xoverlap.ts`;
memory `tournament-opponent-frame` item 17).** Two structural changes, both gate-checked before building:

- **CHANGE 1 — replace `tail(x)`≡0-in-support with a fitted gap-conditioned spread scalar `s_role(gap)`.**
  VERIFIED: in the matchup frame the weak pools land INSIDE league x-support (frame-shifted p10–p90:
  **Gold-q HIT [82,159] / PIT [90,143] — fully within league [88,160]/[90,151]** — yet demand s*=1.72/2.06;
  Open-q in-support wants s≈1). Same x, different slope ⇒ **x is not a sufficient statistic; a tail that
  vanishes in-support cannot represent the effect.** Structure: `K_corr = K̄_pool + s_role(gap)·(K_pred − K̄_pool)`,
  `s(0)=1` hard-anchored (league protection automatic, no partition), fit on the ladder (gap≈0 league+Open,
  Bronze-q/Gold-q plateaus, EG/Bronze-t as out-of-ladder checks), ≤2 params/role (A_role, shared G), e.g.
  `s(g)=1+A·(1−e^{−g/G})`. `gap` = the own-channel K-rating gap (μ_train−μ_pool: stu for pit, kRat for hit),
  the SAME quantity at fit and score time. Lives on the matchup seam (Phase-0 identity at s≡1). Out-of-support
  SHAPE (EG kRat-43 below own-rating support) is SECONDARY — defer unless cleaned-EG residuals still demand it.
- **CHANGE 2 — no standalone pitcher-uBB level term; per-tournament×role level KNOBS only.** The "+6..+8
  off-frame pitcher-uBB" and the Open-quicks format uBB are the SAME number (~constant across gaps) — a
  context level bias, never a frame residual; a global term + free knobs is collinear/unidentifiable.
  VERIFIED role split: Open in-frame uBB **hitter +7.9 / pitcher +5.7** (symmetric context effect). Fit knobs,
  then READ the pattern: constant across tiers incl. gap≈0 ⇒ that constant IS the format effect (record §11,
  promotion-to-term is a later tier-ladder decision); varies with gap ⇒ resurrects a frame component, report
  first. HARD RULE: the uBB correction is never per-card-Stuff-dependent (would double-model StuffAug's BB aux).
  StuffAug stays (keep HR term — off-frame HR≈1.0 is evidence it works; re-exam BB-Stuff at re-fit).

**Mechanism (why this should clear the gate frame-v2 failed):** §11.16's pit-ranking crash (0.68→0.46) =
the flat s=1.75 UNDER-weighting K for pitchers (data wants ~2.1) → finesse arms float up = the Stuff-residual
re-emerging; own-gap wins "by accident" (multiplicative lifts implicitly over-weight strong channels).
`s_pit(gap)` at full strength is the deliberate version. **TEST:** matchup+s(gap) should recover most of the
Bronze-pit Spearman gap vs own-gap; if not, the remainder is a channel-WEIGHTING problem, not spread — report.

**ACCEPTANCE (before any default flip / own-gap sunset):** (1) RECONCILIATION TABLE — every dataset (Open,
Bronze-q, Gold-q, EG-cleaned, Bronze-t) × role × channel, raw vs post-correction bias, showing levels =
format-constant + gap-term with no unexplained leftovers. (2) Scorecard gate — matchup+s(gap)+knobs beats
own-gap on Spearman AND value-regret, per role, on the quicks ladder AND EG-cleaned + Bronze-t (own-gap's
home turf); league in-sample/CV unchanged within the RMSE backstop. (3) The knob-pattern readout recorded.
**FIT HYGIENE:** cluster SEs by running (Bo5 survivorship); ≥100 PA, PA/BF-weighted, ledger-verified only;
cross-tier ladder identifies the ramp (per-tier s* are noisy points on it); same-x sanity check post-fit.
**SEQUENCING:** ~~x-overlap verify + Open uBB role split~~ — DONE (both confirm the design) → s(gap) fit →
knobs → acceptance battery.

**11.20 s(gap) FIT — done (`tools/fit-sgap.ts`).** Joint per-card K fit over the quicks ladder
(Open/Bronze-q/Gold-q, ≥100 PA/BF, PA/BF-weighted, ghost-cleaned), closed-form A per fixed G, grid G:
- **HIT: `s(g)=1+0.76·(1−e^{−g/17.5})`, plateau 1.76** — ≈ the interim hand-tuned (1.75, G0 17); the hand
  value was right for hitters. wRMSE/600 18.2 (no-corr) → 14.3 (fitted ≈ hand).
- **PIT: `s(g)=1+1.03·(1−e^{−g/14.5})`, plateau 2.03** — role split confirmed (higher plateau), but at the
  observed gaps (22–26) fitted s≈1.8, only modestly above the flat 1.75 (RMSE 14.3→12.4 ≈ hand). The higher
  plateau matters for extrapolation to bigger gaps (lower tiers), unobserved yet.
- **s at gaps:** Open ~1.0/1.33, Gold(g26/22) 1.59/1.81, Bronze-q(g42/26) 1.69/1.85; checks EG 1.59/1.81,
  Bronze-t 1.70/1.83. **Caveat:** RMSE gains are modest at current gaps ⇒ the decisive test is the RANKING
  gate (scorecard Spearman/value-regret), not RMSE. SEs not yet clustered-by-running (uncertainty on A_pit
  vs A_hit is real given the small gains). NEXT: per-tournament×role knobs → acceptance battery.

**11.21 PHASE-1 ACCEPTANCE — s(gap) FAILS the pitcher ranking gate; it's a CHANNEL-WEIGHTING problem,
not spread (`tools/phase1-accept.ts`, plan §11.19 acceptance).** matchup + fitted s(gap) vs own-gap,
Spearman + value-regret, per role, ≥100 PA/BF, ghost-cleaned:

| dataset | HIT Spearman own→sgap | PIT Spearman own→sgap |
|---|---|---|
| Open | 0.197→0.203 ✓ | 0.217→0.232 ✓ |
| Bronze-q | 0.315→0.343 ✓ | 0.392→**0.309 ✗** |
| Gold-q | 0.506→0.474 ✗ | 0.338→0.318 ✗ |
| EG-clean | 0.592→0.641 ✓ | 0.588→0.565 ✗ |
| Bronze-t | 0.566→0.549 ✗ | 0.574→**0.387 ✗** |

**VERDICT: the gate is NOT passed.** (1) **PITCHERS: s(gap) REGRESSES ranking on 4/5 datasets** (Bronze-t
0.574→0.387 is a big, N=123 drop on own-gap's home turf) — the SAME regression frame-v2 showed (§11.16), and
the fitted higher s (~1.8–2.0) does NOT rescue it. This **refutes Fable's mechanistic hypothesis** ("s_pit(gap)
recovers the gap"); per Fable's own pre-registration, **the remaining deficit is a CHANNEL-WEIGHTING problem,
not a spread problem — reported, not tuned past.** Own-gap's multiplicative lift reweights ALL channels
(implicitly over-weighting the dominant one → better pitcher ranking); s(gap) only rescales K spread, so it
can't reproduce that. (2) **HITTERS: mixed** (wins 3/5 Spearman) — s(gap) modestly helps hitters. (3) **LEVELS
reconcile CLEANLY** (the accounting closes): sgap collapses every channel toward small residuals (Bronze-t PIT
K −17.2→−4.4, uBB +25.1→+6.9, HR +5.9→+0.8, H−HR +6.7→+4.5). The residual **uBB knob is ~gap-constant
+6..+10 both roles, present at Open (gap 0)** → **CONFIRMS Change 2**: it's a format constant, not a frame
residual. **CONSEQUENCE: do NOT flip the default to matchup+s(gap) — it fails the pitcher gate. own-gap stays.
Phase 1 is BLOCKED on the pitcher channel-weighting problem** (the frame fixes levels but not pitcher ranking;
the K-spread magnitude is not the lever). The s(gap) fit + the clean level reconciliation stand as results;
the ranking fix is a different, open problem.

**11.22 TWO-AXIS GATE (Fable's cardinal-value correction) — adopted; but s(gap) does NOT fix assembled-
VALUE spacing (`tools/phase1-twoaxis.ts`).** Gate revised: the optimizer consumes CARDINAL VALUES (cap/
slots budget math + marginal defense/offense trade-offs need gap SIZES, not order), so judge BOTH axes on
assembled value (wOBA; D2 signed distance is an affine of it): AXIS 1 ORDERING (value-regret + top-N overlap
+ Spearman), AXIS 2 SPACING (spread-ratio SD_pred/SD_actual →1.0 + `gapDistortionRmse`, the affine-invariant
metric in `src/training/metrics.ts`). Reuse it, don't reinvent.
**Result (own-gap vs s(gap), ≥100 PA/BF):**
- **s(gap) does NOT win axis 2 on assembled VALUE.** Pitcher value spread-ratio stays **0.22–0.48** (own
  0.30/sgap 0.34 Bronze-q; 0.22/0.23 Gold-q) — far from 1.0, barely above own-gap; `gapRMSE` is
  own≈sgap everywhere. The §11.17 "K spread 0.5→1.0" was the K CHANNEL fit (tautological: s* is fit to equate
  K spread); it does NOT propagate to VALUE, because pitcher under-separation is MULTI-CHANNEL (§11.18: K +
  hits + BB-level). For HITTERS own-gap is actually the BETTER-spaced (EG spread-ratio own 0.98 vs sgap 0.65;
  Bronze-t 0.82 vs 0.68). So **neither transform restores pitcher value spacing; a K-only fix is insufficient.**
- **AXIS 1 unchanged:** own-gap orders pitchers ≥ s(gap) (regret/overlap ~tie or own better).
- **CAP-BIAS readout (Fable Consequence 2 — the LIVE production bias): CONFIRMED, modest.** Pit-vs-hit value-
  spread compression (pred/real) under own-gap: **EG 0.95, Bronze-t 0.74** (reliable, N 120–290) — pitcher
  upside understated ~5–25% relative to hitters, tilting cap $ to hitters via D2; quicks show more extreme
  (0.41–0.60) but small-N/noisy. **s(gap) does NOT cleanly fix it** (pit/hit 0.43–1.39, over/under by dataset).
**IMPLICATION:** fixing pitcher VALUE spacing (the cap-allocation fix) needs a MULTI-CHANNEL spread restore —
which is exactly what **rating-space widening (Hyp-1)** does (multiplicative-in-ratings widens ALL channels at
once, like own-gap but gap-anchored/fitted), and what single-channel K s(gap) cannot. Hyp-1's two-axis job:
own-gap's ordering (axis 1) + a fitted MULTI-channel spacing that reaches ~1.0 on VALUE (axis 2). This partly
REVISES Fable's Consequence-1 ("s(gap) is the spacing champion" — true only for the K channel, not value).

## 12. Decisions & rationale — WHY we chose each (2026-07-13)

Every significant decision this session, with the reasoning and the alternative rejected. Ordered by area.

### Frame correction

- **Additive channel-crossed OPPONENT-gap shift, over the shipped own-gap multiplicative transform.**
  WHY: a card's outcomes depend on the *opponent's* channel, not its own — strikeouts on the pitcher's
  Stuff, walks on the pitcher's Control, etc. Own-gap lifts a rating by its OWN side's pool gap, which is
  the wrong quantity and diverges in lopsided pools (Bronze pitcher-Stuff gap 47 vs hitter-kRat gap 19).
  Measured: opp-gap collapsed level bias in BOTH eras (Bronze hitter-K +37→−3.6) where own-gap only
  halved it. REJECTED own-gap (directionally right, conceptually wrong).
- **Reference = the model's TRAINING-LEAGUE top-50 field (`trainingMeans`, matched-legs), not the
  catalog top-50 field.** WHY: the model predicts vs the opposition it *trained against*, so the frame
  must be measured against that. As SHIPPED (`f88912c`), `trainingMeans` = the **top-50 of the training
  league**, matched to the top-50 pool μ so the in-frame gap is identically 0; the matched-legs check
  held the out-of-frame levels AND net-improved pitcher uBB (11→6 EG / 14→8 BR).
  **⚠ RETRACTION (memory item 14):** the original rationale — "catalog top-50 mis-bases by +16 on
  hit.eye; the pitcher-BB flat offset vanished once the reference was the training mean (λ→1)" — was a
  **SIGN ERROR**. Under the *usage-weighted* training mean the pitcher-uBB bias DOUBLES (+13/+17,
  λ*≈3.8); the shipped top-50-of-training frame (eye 120.3 ≈ catalog 123) is really **catalog-LEVEL
  basing restored**, and a **+6..+8/600 pitcher-uBB residual REMAINS OPEN** at λ=1 (λ* 1.65–2.7,
  Phase-1 scope). REJECTED the *usage-weighted* training mean; what shipped is the *top-50* training
  field. The level-matching test's value was CONFIRMING matched-legs with a mechanism, not the
  coincidence the sign-error rationale claimed.
- **K-spread scaling S≈1.75 constant (ramped only below G0≈17), not gap-proportional.**
  WHY: measured `s*` ≈ 1.67–1.84, essentially FLAT across own-gaps 17–47 (EG·hit 1.67 at gap 24 ≈
  BR·hit 1.68 at gap 43). Constant-`s` cross-validates EG↔Bronze; a linear-in-gap form OVERSHOOTS on
  cross-validation. Re-verified on ghost-cleaned data (moves ≤0.02). REJECTED gap-proportional. The
  sub-17 ramp is unobserved → provisional until quicks. (A flat `s` under-corrects EG pitchers, which is
  itself an argument for the *fitted* opp-side curve — see below.)
- **Production default stays own-gap; frame-v2 is quicks-gated.** WHY: the switch is roster-CHANGING
  (validation §11.12: weak-pool pitchers lose ~12 of the top-26, K-spread-driven), so flipping it needs
  the deployment gate (quicks confirming the K ramp), not just level-bias improvement.
- **`K̄_pool` centering = top-50 field (Derek deferred the call).** WHY: it's consistent with how `s*` was
  fit (the kslope centers on the realized/≈field mean), it reuses the shift's existing machinery, and it's
  the conservative choice (won't over-scale). Structured as a one-line swap for the realized field once
  quicks measure it. (The realized-field measurement §11.13 later showed top-50 over-states the field —
  flagged for the matched-legs check before Phase 1.)
- **K scaled PRE-era (before `era_k`).** WHY: scaling `e.SO`/`e.K` before era, about the pre-era pool
  mean, is algebraically identical to scaling post-era about the post-era mean (`era_k` factors out of
  the linear map) — so `era_k` applies exactly once, resolving the "K-scaling × era_k double-apply" open
  question.

### Era semantics (the trilogy)

- **`era_gap` → per-SHARE (`era_gap_share`), not per-PA.** WHY: `woba.ts` multiplies `era_gap` onto
  `GAP_rate × BA_fin`, and `BA_fin` already carries the hit level (`era_h`) AND the BIP expansion — so a
  per-PA `era_gap` triple-counts. The only piece it should carry is the XBH *composition* change (share
  of hits that are extra-base), i.e. `(b2+b3)/(h−hr)` ratio. Decomposition holds to 6 dp. Same class as
  the earlier `era_h` fix.
- **`era_bip_adj` — the fixed BIP constant made era-aware.** WHY: the H-curve was fit on
  `BIP = 600 − BB − K − HR − BIP_ADJ` with a FIXED `BIP_ADJ`, but the real non-BIP-out level (HBP+SH+SF)
  varies by era (dead-ball ~24/600 vs 2010 ~10) — so a fixed constant over/understates BIP in extreme
  eras (+2.65% dead-ball hits/XBH). Scale it per era from the rates block; 2010→1 preserves the fitted
  convention. This — not an XBH-share issue — is the true final EG residual (BIP-recompute audit corrected
  §10.5's attribution).
- **Kept the BIP recompute (did not remove it).** WHY: it is the VOLUME channel — the mechanism that
  turns `era_bb/era_k/era_hr` into hit volume via the shared 600-PA budget. Freezing BIP mis-predicts
  hits by −22/+10 per 600 in extreme eras. The per-grain fixes were designed to compose WITH it (carry
  only the residual grain), not replace it. Audit confirmed no remaining double-count.

### Opp-side / matchup model

- **Opp-side matchup model as the eventual DEFAULT — not "frame-v2 as a disposable bridge."** WHY (Derek's
  framing): it's the target architecture, so deploy it and refine *in place* (a curve refit as data
  arrives) rather than ship a bolt-on correction we later rip out. Every data drop then improves one
  model. Grounded in the identity that opp-side trained league-only IS frame-v2's shift, so there's no
  league-only accuracy regression in adopting it.
- **Phase 0 = reparametrize frame-v2 into the model seam with NO refit (bit-identical).** WHY: this is the
  LEAGUE-SAFETY guarantee made structural — proving matchup == frame-v2 (max per-card diff EXACTLY 0)
  means the seam is in place with zero risk of an accidental refit/regression. And because league-only
  opp-side is mathematically frame-v2, there was no accuracy to gain by fitting anything league-only —
  only the architecture + the Phase-1 seam. REJECTED "fit a Form-A curve in Phase 0" (would risk a league
  regression for no gain).
- **`league_curve + tail` partition (tail ≡ 0 in-support) for the Phase-1 fit.** WHY: makes "quicks can't
  hurt league" a PROPERTY OF THE CODE, not a hope — the league-covered region is fit on league data and
  frozen; quicks fits only the beyond-support tail (which league never observes). Plus a hard league-RMSE
  gate as backstop. REJECTED a joint league+quicks fit (could bend the league region to fit quicks).
- **Eval-only carve-out: the K-SHAPE may be *fit* on quicks (the one exception to eval-only).** WHY: the
  eval-only rule exists to protect TALENT estimates from tournament noise (combined lines, format effects,
  ghosts). The K *shape* is MECHANICS — how outcomes bend as the matchup gets lopsided, a structural
  constant of the engine, not per-card talent — so fitting it on quicks does not threaten what the rule
  protects. Narrowly fenced (only the K shape; league region frozen; RMSE gate).
- **The K-slope fix REQUIRES quicks (cannot be done league-only).** WHY: the steeper off-frame K slope
  sits OUTSIDE the league's rating range (EG Q1 hitters kRat 43 < league min ~60) — a data-SUPPORT
  problem no model structure can fix. Confirmed both ways: out-of-frame the spread is 0.4–0.6 of actual;
  in-frame (Open Quicks) the slope ratio is ~1.0, so the defect is a frame artifact, not intrinsic.

### Data QA / ingestion

- **Ghost detection = team-count shortfall + EXCESS-offense (`PA×(rate−pool)`), not raw wOBA or a
  scrub-cluster search.** WHY: forfeit players are GHOSTS that don't export, so the "cluster of low-value
  scrubs" fingerprint is void by construction (the first integrity check searched for it and wrongly
  cleared Bronze). The signals that SURVIVE ghosting are the team-count shortfall (missing team) and the
  ghost-opponent's inflated line. Excess is PA-weighted, NOT raw rate, because raw rate false-positives on
  small-sample luck (July-7 raw #1 was a 488-PA fluke; excess correctly picked the 1667-PA ghost opponent
  Portsmouth). Validated against Derek's ground truth.
- **Surgical cleaning (drop the ghost opponent) over discarding the file.** WHY: Bo7 ghost inflation is
  both extreme AND concentrated on one identifiable team, so it's removable — removal converges the pool
  to the clean 128-team baseline. (Earlier "cleaning is impossible" was wrong for THIS failure mode; it
  would only be unrecoverable if the inflation were small and smeared.) Cost is one team's legit games
  too (~3% PA) — a good trade vs tossing the running.
- **Tournament ingestion is EVALUATION-ONLY, structurally isolated.** WHY: tournament data is messy for
  learning TALENT (combined lines with no split, format/deployment effects, ghosts, thin per-card
  samples); letting it re-fit `f(ratings)` would corrupt the clean league talent curves. Enforced by a
  distinct `TournamentObs` type (lacks the fields fitters read) + no fit/window imports + a guard test.
- **Loader SKIPS combined "ALL" league files (does not error on them).** WHY: they carry no vL/vR split
  so they cannot feed a per-side fit — but they're valid future data (combined-league baseline), so skip
  rather than flag as malformed; a genuinely bad name still reports unparsed.
- **Realized-field: run the "matched-legs" check before touching `μ_pool` — do NOT blindly apply the
  under-correction fix.** WHY: the subagent's field-mean inference ("top-50 over-states → under-correct →
  fix `μ_pool`") conflicts with §10.8/§11.5, where the kslope/ptdiag level-matching used this SAME top-50
  and the level bias DID collapse. The shift is calibrated by LEVEL-MATCHING, not field-means, so the
  level test is the arbiter — acting on the field-mean argument could break what empirically works.
  OUTCOME: the check RAN and vindicated the process — matched legs held the levels AND net-improved
  pitcher uBB, so the arbiter and the field-mean argument agreed; ADOPTED (`f88912c`). The value of
  insisting on the level test wasn't that it overturned the field-mean argument — it's that it *confirmed*
  it with a mechanism instead of a coincidence, so we ship on evidence, not a hunch.

### Process / scope

- **Consolidated plan lives in the repo doc (§11–§12), not only in memory.** WHY: memory is private and
  gitignored; the version-controlled doc is the shared source of truth the team can read and maintain.
- **Format adjustment (BB×0.85 / HR×0.87 / hits×0.96) is on HOLD.** WHY (Derek): only 5 Open runnings; BB
  is robust but HR/hits are small multiples of the noise floor; possible ghost inflation in Open makes
  the multipliers a lower bound; and tiers are needed as the constant-across-tiers consistency test. Not
  a change until the data firms it up.
- **Cleanup bundle DEFERRED (log-linear/tHR/softcaps); only the provably-dead slice removed.** WHY: the
  items are coupled (tHR ↔ the log-linear parity path), risky (removing the log-linear fallback breaks
  ~10 no-eventForm callers), low-value, and premature while the scoring core is in active flux. Took only
  the decoupled dead code (unreferenced ModelTrainingPage helpers) + a stale-README fix.
- **Parallelized via subagents, with worktree isolation where needed and file-disjoint scoping.** WHY:
  independent analyses/builds run concurrently for speed, but scoring-core edits share files and can't be
  parallel — so those were sequenced (Phase 0 → BIP_ADJ), read-only validations ran in parallel (one in a
  git worktree to be immune to main-tree edits), and every subagent's output was reviewed before commit.

## 13. Known soft-spots — where a second opinion is most valuable (audit targets)

Honest list of the least-certain calls this session — the places to scrutinize hardest.

- **PRODUCTION IS UNCHANGED. Read this first.** The production default is STILL `own-gap`. Everything in
  §11–§12 (frame-v2, matchup, era fixes' effect on the *frame path*, matched-legs) is validated but
  quicks-GATED, NOT deployed. The era-semantics fixes (era_gap_share, era_bip_adj) DO change production
  scores for library eras (any tournament, own-gap or not) — those are live. The frame/matchup transform
  changes are not.
- **`era_bip_adj` scaling form.** We scale the FIXED `HIT_BIP_ADJ = 6+3−4 = 5` multiplicatively by the
  era's `(1−bb−k−hr−bip)` ratio. But that constant sign-conflates HBP (non-BIP, subtracted), SH (a BIP
  event) and SF (+4). The era ratio uses the aggregate non-BIP-out fraction, which is dominated in
  dead-ball by SAC BUNTS (SH). Is a multiplicative scale of a sign-conflated constant the right grain, vs
  an absolute per-era value or a per-component (HBP vs SH vs SF) treatment? It's small (dead-ball-only,
  ~+2.6% pre-anchor) but it's the shakiest of the three era fixes.
- **Matched-legs ↔ `S_K` interaction (real, un-retuned).** Adopting matched-legs (`trainingMeans` = top-50
  of training) shifted the `s*` the data wants UP ~7–8% (EG·hit 1.70→1.85, BR·pit 1.87→1.98, EG·pit
  2.36→2.50). The code still uses the constant `S_K = 1.75`, so under the matched frame it now mildly
  UNDER-corrects the K spread. Deferred deliberately — the quicks Phase-1 fit REPLACES the hand-tuned `s`
  with a fitted tail, so retuning the interim constant now is throwaway. But it means the current
  (matched-legs + `S_K=1.75`) pairing is a knowingly-slightly-mismatched interim until Phase 1.
  **CONFIRMED (Derek, 2026-07-13): LEAVE `S_K=1.75` as-is** (do NOT ship a role-split interim like
  hit 1.8 / pit 1.9, even though the Batch-2.7 re-fit shows pitchers want more). The Phase-1 fitted
  per-role K tail replaces it properly (ramp + level residual + the pitcher-uBB BB-channel term all in
  one out-of-frame fit); a hand-tuned per-role constant would be throwaway and could itself be wrong
  (EG·pit ~2.5 is confounded by the −10/600 dead-ball pitcher-K level residual). Re-fit values on
  clean, production-centered, matched-legs data: **hitters ~1.8 (EG 1.88 / BR 1.76), pitchers BR 1.86,
  EG·pit confounded**; pitcher-uBB residual +6..+8/600 (λ\* EG 2.62 / BR 1.63) — the BB-channel sibling,
  Phase-1 scope.
- **`K̄_pool` centering still uses the pool's top-50 field** (unchanged by matched-legs, which only touched
  `μ_train`). Verify this is consistent with the now-top-50 `μ_train` frame and doesn't reintroduce an
  asymmetry in the K-scaling centering.
- **Format effect (BB×0.85 / HR×0.87 / hits×0.96)** rests on 5 Open runnings; HR/hits are small multiples
  of noise; if Open itself has ghosts the multipliers are a lower bound. Correctly on HOLD — but don't let
  it be read as settled.
- **`S_K=1.75` sub-`G0=17` ramp** is entirely unobserved (`G0` is a guess); provisional until quicks.
- **Sample sizes.** Many findings rest on few runnings (Bronze 3, EG 7, Quicks 5) and few high-PA cards
  per tournament — weigh the statistical power, especially per-role, per-channel splits.
- **The temp `41-42` model** used in several late validations may or may not be uBB-trained — if it
  predicts raw BB, the pitcher-uBB residuals carry an IBB confound (tournament IBB 1–2.4/600). Re-check
  the uBB-vs-rawBB status of whatever model backs any pitcher-BB conclusion.
- **Falsified hypotheses (don't re-litigate, but verify we killed them correctly):** per-BIP unit
  elasticity (made EG worse), gap-proportional K scaling (overshot cross-val), weak-pool own-rating
  extrapolation (ratings sit inside league range), and the first "Bronze is clean" ghost check (used the
  wrong fingerprint — ghosts are invisible).
