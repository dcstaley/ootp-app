# cwhitstats Calibration Program — Handoff to Fable (2026-07-14)

Session summary for the cwhitstats-driven audit + Batch-3 baserunning fix. Written for Fable to pick up
the deferred items with full context. Companion records: memory `cwhit-program-batch-state`,
`overscoring-stuff-residual`, `cwhitstats-external-data`; plan `docs/REBUILD_TOURNAMENT_MODEL_PLAN.md`
§14 (Fable handoff bucket). All commits on `main` (c8aedd9 back through e771a46).

---

## 0. TL;DR

- **SHIPPED (deployed wOBA path):** baserunning value — the audit's one clean, actionable defect. The
  model had weighted baserunning at **exactly zero**; it now credits UBR (Speed + Baserunning) and steals
  (a **tendency × ability** term), **era-scaled** from newly-imported BBRef SB/CS/R factors. Example:
  Rickey Henderson (bronze-quick) +19 mwOBA both sides.
- **RIGOROUSLY BOUNDED (not fixable per-channel):** every *other* audit defect (pitcher stuff-spread,
  pitcher BB-over, hitter HR-under, hitter BABIP-over) is a **frame/population effect** — proven by an
  in-sample league check showing ~0 in-frame bias. Per-channel fixes are impossible by construction; the
  only non-settled path is the **M8 matchup model**. Documented as one bucket in plan §14.
- **VALIDATED:** our loader/ingestion against cwhit's community aggregate — exact match (loader is GREEN).
- **NO RETRAIN NEEDED** for any of this: baserunning is applied at scoring time (`resolveCoeffs`), not in
  the trained artifact; and the audit measures the trained event model, which baserunning doesn't touch.
  (Derek should retrain+restart only to see baserunning live on the grid, since `seedEras` re-syncs the
  era factors on boot.)

---

## 1. What shipped — the baserunning fix (Batch-3 #1)

**The defect.** The deployed hitter value ignored baserunning entirely: `w_speed/w_run/w_steal = 0` and
`adv_speed/adv_steal/adv_run` were declared but never assigned. The cwhit audit showed the
Speed/Stealing/Baserunning ratings *strongly* predict observed baserunning (corr up to 0.93 for
Baserunning→UBR), so ~6 mwOBA SD of real, well-measured value was being thrown away.

**Fit on OUR league data (trust hierarchy — cwhit only confirms).** `tools/baserunning-fit.ts`.
Wrinkle: baserunning is **not a platoon split**, so the vL/vR training files carry the SB/CS/wSB/UBR
columns *empty*; the populated data lives in the **"ALL" (unsplit season-total) league exports**
(`League Files/Model 2042/*ALL*.csv` — 5 leagues, 1645 hitter-seasons ≥300 PA). The fit reads those.

**Two components, treated differently:**
- **UBR** (taking extra bases on hits) — the bigger part (SD 3.05 runs/600). Clean additive:
  `Speed` + `Baserunning`, fit corr 0.75 (rest is single-season noise). Wired as `adv_speed`/`adv_run`.
- **Steal value (wSB)** — smaller (SD 1.45) and genuinely **interactive** (Derek's catch: there are two
  steal ratings — `Steal Rate` = *tendency/aggressiveness*, `Stealing` = *ability*). Adding the
  interaction lifts the wSB fit r 0.39→0.48 and collapses the main effects. In the additive fit the β for
  `Stealing` (the model's *only* pre-existing steal input) is ≈0 — **ability alone is nearly valueless**;
  value = tendency paired with ability. The wireable form: `stealValue ∝ SR·(0.00051·STE − 0.046)` — a
  clean **breakeven at ability ≈ 90** (below-average base-stealers *lose* value by running; above-average
  gain, scaled by tendency). Validated on real players:
  - Kenny Lofton (ability 124 / tendency 118): **+4.3 mwOBA** (elite — biggest gain)
  - Mike Tresh (ability 14 / tendency 56): **−4.5 mwOBA** (reckless — biggest penalty; note this is the
    *closest* real card — the game rarely pairs high tendency with low ability)
  - Garrett Atkins (ability 100 / tendency 28): **≈0** (able but passive → rarely attempts)

**Era scaling (Derek's catch — baserunning value is era-dependent).** The BBRef era source
(`docs/bbref_batting_league.csv`) carried **SB/CS/R** per year but `eras-bbref.ts` dropped them. Now
imported into two era factors (auto-synced by `seedEras` on boot):
- `sbFreq` = era SB/PA ÷ 2010 (stealing *frequency*; 0.77×–2.27× across history)
- `runVal` = 2010 R/G ÷ era R/G (run *scarcity* — a baserunning run is worth more when runs are scarce;
  e.g. the 1968 pitcher's era = 1.28× despite low steals)

**DOCUMENTED DECISION (for Fable to revisit):** steal value scales by `sbFreq × runVal`; **UBR scales by
`runVal` only**. Rationale: taking the extra base is an era-stable *skill* whose opportunity frequency
rides hit rates (already era-captured via `avg`/`gap`), not an era's stolen-base aggressiveness — so
applying `sbFreq` to UBR would conflate two different phenomena, and BBRef has no extra-base-taken
frequency to measure it directly. Conservative call; revisit if per-era UBR/XBT data appears.

**Both components are WIRED + deployed** (verified end-to-end). `woba.ts baserunningWoba` is called from
`trustedHittingWoba` (the deployed score) and `assembleRawHittingWoba`, computing
`adv_speed·Speed + adv_run·Baserunning + adv_stealRate·SR + adv_stealInt·(SR·Stealing/100)`. The old
linear ability-only `adv_steal` is retired (=0). `resolveCoeffs` sets `adv_speed`/`adv_run` = UBR base ×
`runVal`, and `adv_stealRate`/`adv_stealInt` = steal base × `sbFreq · runVal` (the `SR` = Steal Rate input
is threaded through `calibrate/score-card/pool-stats`). Rickey Henderson (bronze-quick) +19.1 vR / +19.2 vL
mwOBA (side-invariant — baserunning has no platoon split): ~UBR 15 + steal ~4 (ability 98 > breakeven).

**External confirmation (cwhit).** The league-fit noiseless spread (2.79 runs/600) ≈ cwhit's deep-sample
observed spread (2.93, PA≥2000) — the league fit independently reproduces the cwhit magnitude.

**Design decision — baserunning is ADDITIVE (removed from the calibration anchor).** As first wired,
baserunning sat in `anchorHittingWoba`, so turning it on dragged non-runners *down* (~−9 mwOBA of batting
value for a slow slugger, purely from the anchor re-centering). Fixed: the anchor calibrates **batting**
to `TARGET_WOBA`, and baserunning is a pure bonus in the trusted score (like WAR's batting + baserunning
runs). Non-runners keep their batting wOBA; runners gain on top. Hitters now average slightly above 0.320
(correct — they carry extra value pitchers don't).

**Coefficient home.** `resolveCoeffs` derives `adv_speed`/`adv_run` from scoring-core constants
(`ADV_SPEED_UBR`/`ADV_RUN_UBR`, the 2010-baseline league fit) × `era.runVal`. NOT a flat constant (Derek's
steer — it's era-scaled). They're now *derived* post-assembly, so excluded from the coeff-resolve
round-trip byte-identity test (same category as `era_h_bip`).

---

## 2. The cwhit audit — methodology + findings

**Setup.** `tools/cwhit-audit*.ts` compare our predictions vs cwhit's RAW EVENT aggregates (ground truth;
his wOBA/projection columns are NOT truth — Derek), per channel × role × tier, over the neutral-env Quick
tiers (Derive: Quicks are neutral era/park; dailies are not → excluded until their env is pulled). The
join layer (`src/eval/cwhit/`, `tools/cwhit-join.ts`) keys Name+VAL+VLvl+Hand with rating-fingerprint
disambiguation for the ~3% display-key collisions.

**Key methodological finding — the frame dominates absolute comparison.** Raw (no own-gap) pred−obs is
dominated by the opponent-frame gradient (pitcher wOBAA bias +65 iron → +31 diamond; hitter −49 → +8). So
absolute levels are NOT the calibration signal — the **within-tier residual** (own-gap applied) is.

**own-gap works.** Applying the deployed own-gap transform flattens the pitcher tier gradient to ~+16..+22
(uniform), confirming own-gap's core function on external data for the first time.

**Confirmed defects (deployed, own-gap):**
- **Pitcher stuff under-credited** +1.53 mwOBA/+10 (within-tier partial slope, survives own-gap). The
  con-vs-stu attribution the diagnostics left open is settled: it's **stuff** (control is a weak
  over-credit). = the logged Donohue "over-rates low-stuff/high-control" case.
- **Elite-tail spread deficit** — the question is no longer data-bound (was τ→0 on our 9 runnings): cwhit
  measures observed SP wOBAA SD = **0.0106** (IP≥1500, ~0 noise); deployed pred spread = **0.068** (64%).
- **Uniform pitcher BB over-prediction** (~+18 mwOBA residual; pred 3.26 vs obs 2.60 BB9 even post-own-gap).
- **Hitter HR under-predicted, BABIP over-predicted** (pow −1.42, babip −1.66 mwOBA/+10 slopes).

**Baserunning first-look** (never validated before): ratings predict observed baserunning strongly
(corr 0.93 UBR / 0.52 wSB) — the ratings are good; they were just unused. → the fix above.

---

## 3. Validations (why we trust the above)

- **Loader reconciliation — GREEN** (`tools/league-reconcile.ts`). cwhit's League tabs are the SAME
  450-453+PEL leagues (Derek: PEL=Perfect, HD450-453=Diamond; our sim-"years" = cwhit real weeks;
  2042 = "Week Of 7:6"). Our loader vs cwhit week 7:6 (Diamond+Perfect combined): **PA, BB%, HR600, BABIP
  match EXACTLY** (8 hitters); **IP/K9/BB9/HR9 within ~0.2%** (7 pitchers). Ingestion is correct. Our
  League Files ARE the shared community export (Jackie Robinson 79.6k PA both sides — ~0 noise, which is
  why deep-eval samples matched cwhit).
  - **Definitional gotcha:** cwhit SO% = **K/AB**; our convention = **K/PA** (our K/AB == cwhit SO% to the
    decimal). NOT a bug. Implication: the audit's standalone SO% channel used mismatched denominators — but
    SO isn't a wOBA event, so HR/BABIP/wOBA/frame conclusions are unaffected. Re-read SO% on K/AB if used.
- **Frame attribution — PROVEN** (`tools/insample-frame-check.ts`). In-sample league bias (pred−obs,
  PA/BF-weighted, by rating quartile) on the deployed forms: hitter HR←Power **+0.03** (flat), hitter
  BABIP **+0.06**, pitcher uBB←Control **−0.19**, pitcher K←Stuff **+0.38** (top-stuff quartile **+2.1** —
  we already OVER-predict high-stuff K in-frame). All ~0/flat in-sample while cwhit tournaments show large
  bias ⇒ all four are FRAME/population effects, NOT fittable defects. The K row is decisive: league can't
  support a steeper stuff→K (the extra Ks exist only vs tournament hitters).
- **External confirmation of baserunning** — league fit spread 2.79 ≈ cwhit 2.93 runs/600 (§1).

---

## 4. OPEN QUESTIONS / DEFERRED ITEMS (for Fable)

### 4a. The frame class — the big one (plan §14)
All remaining defects are one frame/population class; per-channel fixes are impossible by construction
(in-frame unbiased). Two gated options, both reopen/escalate → require the CI-clear bar (7 forms died at
gates this program):
- **(A) Reconsider `kSpread` with the NEW external cwhit evidence.** kSpread (the pitcher spread-scaling
  knob, aka "Hyp-1 s_pit") is currently a *settled-dead negative* — but it died on league-deconvolution
  evidence, and cwhit is now independent ground truth (elite spread 0.106). Re-test ONLY as a fully-gated
  study: fit s_pit on OUR league data, two-axis gate (order AND spacing, CIs), PLUS an external gate — the
  deployed elite-SP spread must reach ~0.106 at cwhit depth (`tools/cwhit-audit-deployed.ts` §3). Clear it
  CI-clear or it stays dead with stronger evidence. Reuse `tools/family-twoaxis` + `phase1-spacing` +
  `eb-elite-spread`.
- **(B) Escalate to the M8 two-argument matchup model** (`docs/REBUILD_MATCHUP_CHANNEL_PLAN.md`) as a
  bake-off candidate — fit on our data, cwhit as the EVAL set. The Tier-3 trigger. Prior matchup was
  refuted on the value path (plan §11.19–11.23); the new angle is cwhit as an external evaluator rather
  than league-deconvolution. Large effort. Adopt only on CI-clear improvement in BOTH elite-tail spread
  (→0.106) AND regret/top-26, with no in-frame order loss.

### 4b. Baserunning follow-ups
- **Basic-score path** (`w_speed`/`w_run`/`w_steal`) — the ONE remaining unwired piece. Deferred: it's a
  different anchored scale
  (`TARGET_BASIC=100` vs wOBA 0.320) and functional form (log-rating terms + linear baserunning), so it
  needs its own calibration, not a hasty conversion. The deployed optimizer uses the wOBA path, so the
  behavior change is already in effect; basic is a secondary/display metric.
- **UBR era-scaling** (`runVal`-only) is a documented judgment call (§1) — revisit if per-era
  extra-base-taken frequency ever becomes available.

### 4c. Smaller open threads
- **Dailies audit** — the non-neutral daily formats (Bronze Heart, Early Gold, Gold/Diamond Cap) were
  excluded from the own-gap absolute-level analysis pending their per-era/park env. Pull env → extend.
- The audit's **SO% channel** should be recomputed on K/AB if ever used (§3 definitional note).

---

## 5. Challenges / gotchas encountered (so Fable doesn't re-hit them)

1. **Baserunning wasn't reaching the deployed score.** The `adv_*·rating` term lived only in
   `assembleRawHittingWoba` (the "raw stored column for calibration guards"), NOT in `trustedHittingWoba`
   (the deployed score) or `hittingComponents`. Setting the coeffs alone did nothing until traced. Verify
   any new value term actually flows to `trustedHittingWoba`, not just the raw assembly.
2. **Anchor re-centering** (the −9 mwOBA slow-slugger surprise) — see §1. New additive value axes should
   generally stay OUT of the anchor.
3. **Split-file baserunning is empty.** vL/vR league files have SB/CS/wSB/UBR columns but they're blank
   (baserunning isn't platoon-split). The populated data is the "ALL" files, and only 2042 has them. So
   the loader (which trains on split files) can't see baserunning; the fit reads ALL files directly.
4. **Steal = tendency × ability, not additive** — the model's single `Stealing` (ability) input is ≈0
   additively. Don't wire steal as a linear ability term.
5. **The frame confound is everywhere.** Absolute pred−obs is dominated by opponent-frame; always work in
   within-tier residuals (own-gap applied) for calibration signal, and use the in-sample check to
   distinguish frame from fittable defect before proposing any form change.
6. **cwhit access discipline** (Derek): in-app Claude_Browser (NOT claude-in-chrome), gentle — one loaded
   session, a handful of reads, "Show 100" + get_page_text, no bulk-crawl, no arbitrary JS on the site.

---

## 6. Tools built this session (all on `main`)

- `src/eval/cwhit/{parse,join,audit}.ts` + `index.ts` — the reusable cwhit parse/join/audit core (tested:
  `tests/cwhit-join.test.ts`, `tests/cwhit-audit.test.ts`).
- `tools/cwhit-join.ts` — first join readout (95–100% match on Quick tiers).
- `tools/cwhit-audit-deployed.ts` / `-deployed-hit.ts` — the own-gap deployed audit (pitcher + hitter).
- `tools/baserunning-fit.ts` — the league-data baserunning value fit (UBR + steal interaction).
- `tools/baserunning-examples.ts` — the 5 steal archetypes on real players.
- `tools/insample-frame-check.ts` — the frame-attribution proof.
- `tools/league-reconcile.ts` — the loader reconciliation vs cwhit.
- `fixtures/cwhit/*.tsv` — the pinned cwhit snapshot (18 tier tables) for reproducible audits.
- Batch-1 safety infra (earlier): `tools/` deploy vertex gate, tangent-linear extension, import tripwire.

---

## 7. The doctrine (do not drift)

Trust hierarchy: (1) our league exports = the ONLY fitting data; (2) our tournament exports = full-pool
eval; (3) cwhit RAW EVENT aggregates = deep eval ground truth; (4) cwhit projections = triangulation
opinion, weight ZERO as truth; (5) cwhit League tabs = the SAME data as our League Files → loader
reconciliation only, never a second training source. Decisions stand, error bars shrink: adopted forms
aren't reopened by default — they're tested at ~10× power and reopen only on CI-clear defects. Settled
negatives stay dead (additive-scoring, kSpread, thin-native, per-BIP, saturating-BB) unless CI-clear new
evidence reopens them under the full gate.
