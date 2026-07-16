# cwhitstats Program — Handoff to Fable #2 (2026-07-16)

Continues `docs/CWHIT_PROGRAM_HANDOFF_2026-07-14.md` (that one: the audit + the initial baserunning
ship). This covers everything since (13 commits, `8cff456..d71a379` on `main`): the baserunning
CORRECTNESS saga (Derek caught the magnitudes were wrong — three real bugs), the metric SPLIT
(Offense / wOBA / BsR) + its UI, and the three POST-SHIP cwhit audits — including the triangulation
that gives the first concrete evidence on the parked M8 question. Companion: memory
`cwhit-program-batch-state` (the running record) + `overscoring-stuff-residual`.

---

## 0. TL;DR

- **Baserunning is now CORRECT, not just wired.** Derek's "aren't those MASSIVE jumps?" was right. Three
  bugs fixed: (1) not centered → a +9.4 mwOBA universal uplift; (2) scaled by the calibration `sFinal`
  (a 15%-at-bronze, tier-dependent inflation); (3) a residual +2.8 drift from centering over pitchers +
  an anchor selection/normalization mismatch. Final: baserunning Δ **mean 0.00**, full spread intact
  (−9.3 to +16.6 mwOBA), correctly signed (good baserunners +, bad −). Rickey Henderson +19 → +11.
- **The metric is split three ways** and honestly named: **Offense** (= wRAA + BsR, wOBA scale — what the
  optimizer ranks on) = **wOBA** (batting-only, real wOBA, comparable to cwhit + the real world) + **BsR**
  (baserunning runs/600). Exposed on the grid (columns) and roster/lineup (BsR column + tooltips).
- **Three post-ship cwhit audits ran** (two via parallel subagents on cached data, one by browsing):
  BsR validation (**deployed BsR corr 0.93 to observed — well-calibrated**), variant-lift validation
  (v5 boost calibrated on value; one small Stuff→K under-shoot), and the **triangulation** (below).
- **M8 now has evidence.** Triangulation (ours vs cwhit's tournament-trained projection vs observed):
  **his model beats ours on BB9/HR9/BABIP — exactly the frame-bound channels** we proved un-fittable on
  league data — **but ours beats his on K** (his runs hot; ours is accurate at high stuff). So a
  tournament-native (M8) model is evidence-backed for the frame channels, but must PRESERVE our K.
  **[superseded — the benchmark scorecard's level/shape split showed these "wins" were LEVEL results, not
  ordering; see plan §15 (governance) + handoff #3 §2]**

---

## 1. Baserunning correctness — the "massive jumps" saga

Handoff #1 shipped baserunning (UBR + steal tendency×ability, era-scaled, additive). Derek then flagged
the per-card jumps looked far too large. He was right; three distinct bugs, fixed in order:

**Bug 1 — not centered (commit 5e16f2d).** The fit intercept was dropped ("the anchor absorbs the
constant"), but baserunning was then made ADDITIVE (removed from the anchor) — so the constant was
neither in the term nor absorbed. Every hitter got a **+9.4 mwOBA universal uplift** (min −0.1, nobody
negative). Fixed by subtracting a pool-mean center (`calScales.brCenterHit`) in `trustedHittingWoba`.

**Bug 2 — scaled by `sFinal` (commit 5e16f2d).** `battingWoba * sFinal + brBonus` — but as first written
the BsR term rode INSIDE `* sFinal`. `sFinal` is the CALIBRATION correction for the batting event model's
scale drift, and it is NOT ~1: **1.151 at bronze, 1.056 gold, 1.024 neutral**. So multiplying BsR by it
inflated it 15% at bronze and MORE at lower tiers (a tier-dependent distortion). The BsR term is fit in
REAL wOBA units (league wSB/UBR runs), so it's already on the true scale ⇒ add it AFTER `sFinal` (and
after `ssp` — BsR has no platoon component). Derek's instinct ("feels like after scaling") was correct.

**Bug 3 — residual +2.8 drift (commit c489e6e).** After 1+2, the mean was still +2.8 (production pool).
Two causes: (a) `brCenterHit` averaged over the WHOLE pool including pitchers (who barely bat) using the
`x>0`-filtered `mean` helper — the center sat low, so every hitter read positive; (b) the anchor SELECTED
its top-50 on Offense (batting+BsR) but NORMALIZED on batting-only, so toggling BsR shifted `sFinal`.
Fixed: `brCenterHit` is now a TRUE mean over HITTERS only (`Position != "1"`), and the anchor `woba` is
batting-only (pass 0 for baserunning in `calibrate`). Result: **Δ mean 0.00**, spread intact.

**Net state (verified):** average hitter's BsR ≈ 0; cards are ±by their edge over the hitter field; below-
average baserunners correctly go negative (Derek: "fine with baserunning going negative if handled
correctly"). Deployed-BsR externally validated at corr 0.93 (§3). **Rickey Henderson: Off 0.309 = wOBA
0.300 + BsR 4.6 runs.**

**IMPORTANT framing (Derek):** our "wOBA" is really **OFFENSE = wRAA + BsR** as a rate stat (the offense
component of WAR), NOT real wOBA. cwhit's wOBA (and the real world's) is batting-only — confirmed two ways
(his hitter table lists wOBA *alongside* separate wSB600/UBR600, and our batting-only reconstruction of
his wOBA matched at corr 0.986). So our AUDIT stayed consistent (batting vs batting), but **any future
comparison of the DEPLOYED score to cwhit must add his wSB600+UBR600 to his wOBA, or compare batting-only.**

---

## 2. The metric split — Offense / wOBA / BsR

Derek's call (cleaner than the alternative): rename the existing conflated metric to what it already is,
then split out the pieces. Zero behavior change (the optimizer already consumed batting+BsR).

- **`scoreCard.hit`** now carries `offense_vL/vR/ovr` (Offense, the value metric — what `valueFor` +
  optimizer use), `woba_vL/vR/ovr` (batting-only real wOBA), and `bsr600` (side-invariant). The one-core
  math: `hittingBsr` in `woba.ts` (raw baserunning − pool center) is the single home for the centering,
  consumed by both `trustedHittingWoba` (Offense) and score-card (to split). `offense = woba + bsr`.
- **Pitcher `pitch.woba_*` is untouched** — genuine wOBA-against (no baserunning).
- **Rename-first was deliberate** (`hit.woba_*` → `hit.offense_*` as a pure rename, THEN add the new
  batting `woba_*`): renaming made the compiler flag every consumer (5 tools I'd have missed), so nothing
  could silently switch metric. The raw-poly test was re-pointed to the batting-only `woba` (it guards
  batting == the bake-off model; it had passed before only because its fixtures have baserunning=0).
- **UI:** grid columns **Hit Off / Hit wOBA / BsR** (the old "Hit wOBA" label was a lie, now fixed).
  Roster: a **BsR column** (after vR; green/red signed runs, dim when negligible) + Off vL/vR relabel +
  value tooltips + a heading note "values are Offense, not wOBA". Lineup: compact inline BsR by the score.
  (First tried a name-attached badge — Derek: clipped by ellipsizing names + wrong association; moved it
  to the score columns.) Available-pool cards show Offense but not the BsR split (custom render; deferred).

---

## 3. Post-ship cwhit audits (all committed as tools)

**#2 — BsR validation (`tools/cwhit-bsr-validate.ts`).** Deployed `bsr600` vs cwhit observed
`wSB600+UBR600`, per Quick tier + pooled (both re-centered to own means). **Pooled corr 0.93** (0.87–0.945
per tier), **spread-ratio 0.94** (mild ~6% tail compression — we slightly under-credit the fastest / under-
penalize the slowest; NO directional bias). Elite basestealers (Coleman, Wills, Ichiro) and clogs land
where cwhit puts them. ⇒ the shipped baserunning is externally confirmed well-calibrated.

**#3 — variant (v5) lift validation (`tools/cwhit-variant-validate.ts`).** cwhit same-card VLvl-0 vs
VLvl-5 lift vs our `scoreCard(base)` vs `scoreCard(makeVariant(base))`. Key: base and v5 share the same
frame within a tournament, so **environment CANCELS in the difference** → all 9 tables pool, neutral-env
prediction compares validly (N 185 hit / 191 pit; own-gap robust). v5 boost **well-calibrated on VALUE**
(hitter wOBA +13.4 vs +15.0m obs; pitcher wOBAA −10.7 vs −12.4m, both CI-clear). ONE flag: **v5 Stuff
boost yields ~0.1–0.15 FEWER K9 than observed** (significant) — a WITHIN-FRAME corroboration of the stuff
theme, but small and it washes out at wOBAA.

**#1 — triangulation (`tools/cwhit-triangulate.ts`, projected data `fixtures/cwhit-proj/`).** Ours vs
cwhit's PROJECTION (his tournament-trained model) vs OBSERVED, Bronze Quick pitchers, N=30 well-sampled.
Who tracks observed better (mean |pred−obs|): **K9 OURS** (0.78 vs his 1.27), **BB9 CWHIT** (0.28 vs
0.87), **HR9 CWHIT** (0.10 vs 0.21), **BABIP CWHIT** (0.005 vs 0.010). By stuff bin, our K9 bias shrinks
+1.31(low)→**+0.04(high)** — accurate at the top — while his over-predicts K uniformly +1.2..1.4.

---

## 4. THE M8 EVIDENCE (the headline for Fable)

> **[superseded — see plan §15 governance section]** The scorecard (handoff #3 §2) re-ran this with the
> level/shape split: the BB9/HR9/BABIP "wins" below are LEVEL effects (real frame effects, but convention
> per Ruling 1's scope), NOT ordering advantages — 0 CI-clear shape wins either way. M8 = no-go **as an
> ordering fix**; the spacing verdict awaits the MMSE battery (plan §15.5).

The triangulation is the first concrete read on the parked M8 (two-argument matchup) decision:
- cwhit's **tournament-native model materially beats ours on BB9 / HR9 / BABIP** — precisely the
  **frame-bound channels** we PROVED un-fittable on league data (handoff #1 §4c, `insample-frame-check`).
  This is direct evidence that a tournament-native (M8) model WOULD recover the frame effects.
- But it **does NOT beat us on K** — ours is accurate at high stuff; his runs hot (+1.2..1.4 K9). This
  re-confirms the K *counts* are fine (the stuff issue is value/spread, not the K channel — §3 variant
  corroborates the small residual).
- **Design constraint for M8:** it must FIX BB/HR/BABIP (frame) while PRESERVING our K behavior — not a
  wholesale model swap. A hybrid (tournament-native BB/HR/BABIP levels, our K curve) is the shape the
  evidence points to.
- **Caveat:** N=30, ONE tier (bronze), pitchers only. Suggestive, not definitive.

---

## 5. OPEN QUESTIONS / DIVE-DEEPER (for Fable)

1. **[done — the benchmark scorecard delivered this across all 5 Quick tiers × both roles; verdict in plan
   §15.6]** **Strengthen the triangulation before committing to M8.** N=30/one-tier/pitchers-only. Capture cwhit
   Projected Pitchers for more Quick tiers (iron/silver/gold/diamond) + Projected Hitters, and re-run
   `cwhit-triangulate.ts` (generalize it past bronze). Confirm the "his-model-wins-on-BB/HR/BABIP,
   ours-wins-on-K" pattern holds across tiers. This is the gate before any M8 build. (Browsing: in-app
   browser, GENTLE — the projected tables key by full //Card Title = exact catalog join.)
2. **M8 as a HYBRID, not a swap.** Given #4, design M8 to correct the BB/HR/BABIP frame levels while
   leaving the K channel to our (accurate) curve. Fit on our data, cwhit as eval (per the trust
   hierarchy). Is the two-argument matchup form the right vehicle, or a narrower per-channel frame overlay
   on just BB/HR/BABIP? (Note: broad frame overlays were a Tier-3 concession, gated — see handoff #1 §4a.)
3. **Why does cwhit's model run HOT on K?** His tournament-trained model over-predicts K by +1.2..1.4
   uniformly, while observed K is lower. Is that a systematic bias in HIS model (over-fitting tournament
   K), or does it tell us something about the K environment? Worth understanding before trusting his
   projections as an M8 target on any channel.
4. **The steal tendency×ability form.** Steal value = `SR·(0.00051·STE − 0.046)` — a linear-product with
   a breakeven at ability ≈90. Is the product form right, or is there a better functional shape (e.g. an
   attempt-rate × success-rate model with an explicit CS penalty)? The #3 variant audit's small Stuff→K
   miss is unrelated, but the steal form itself has never been stress-tested beyond the one fit.
5. **BsR data depth.** The BsR fit uses only the 2042 "ALL" league files (one week, 1645 hitter-seasons) —
   the only week with populated wSB/UBR (the vL/vR training files carry the columns EMPTY). More weeks of
   ALL-file exports would tighten the fit and let us check BsR stability over time.
6. **UBR era-scaling — documented judgment call.** UBR scales by `runVal` (run scarcity) only, NOT
   `sbFreq`; steal scales by both. Rationale: extra-base-taking is an era-stable skill whose opportunity
   rides hit rates, not stolen-base aggressiveness — but BBRef has no extra-base-taken frequency to
   confirm it. Revisit if per-era XBT data appears.
7. **BsR tail compression (spread-ratio 0.94).** The deployed BsR spread is ~6% narrower than observed —
   the extremes (Coleman +8.05 vs obs +10.20) are pulled in. Modest shrinkage, not a bias. Worth
   un-compressing (steeper slopes) or leave as defensible regression-to-mean? Low priority.
8. **Centering baseline.** BsR is centered on the POOL's hitters (per-tournament), so "average" is the
   eligible field. Is pool-relative right for value (edge over the field you pick from), or should it be a
   fixed league-average baseline for cross-tournament comparability? Currently pool (matches own-gap).
9. **Basic-score baserunning path** (`w_speed/w_run/w_steal`) — the ONE unwired metric path. Different
   anchored scale (TARGET_BASIC 100), needs its own calibration. Deferred by Derek behind everything.

---

## 6. Files added this session

- Scoring: `src/scoring-core/woba.ts` (`hittingBsr`, `bsrToRuns600`, split), `calibrate.ts` (batting-only
  anchor + hitter-centered BsR center), `score-card.ts` (offense/woba/bsr split).
- UI: `web/CardsPage.tsx`, `web/RosterPage.tsx`, `web/LineupTab.tsx`, `web/roster-cells.tsx` (`bsrTag`),
  `web/shared.ts`, `src/server/server.ts` (API split + `bsrByDisp`).
- Audit tools: `tools/cwhit-bsr-validate.ts`, `tools/cwhit-variant-validate.ts`, `tools/cwhit-triangulate.ts`.
- Data: `fixtures/cwhit-proj/cwhit-bronze-pit-proj.tsv` (cwhit's projected pitchers, Bronze Quick).

---

## 7. Doctrine (unchanged — do not drift)

Trust hierarchy: our league exports = only FITTING data; our tournament exports = full-pool eval; cwhit
RAW EVENTS = deep eval ground truth; **cwhit PROJECTIONS = triangulation opinion, weight ZERO as truth**
(used here only as a third reference to locate defects); cwhit League tabs = loader reconciliation only.
Decisions stand, error bars shrink; settled negatives stay dead unless CI-clear new evidence reopens them
under the full gate. cwhit browsing: in-app Claude_Browser, GENTLE (a handful of reads, "Show 100" +
get_page_text, no bulk-crawl, no arbitrary JS on the site).
