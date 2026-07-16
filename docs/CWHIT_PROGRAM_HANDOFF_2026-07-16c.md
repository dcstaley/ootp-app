# cwhitstats Program — Handoff #3 (2026-07-16, later same day)

Continues `docs/CWHIT_PROGRAM_HANDOFF_2026-07-16.md` (handoff #2). Fable wrote work-order #3; this is the
delivery report against it, **plus a section on a confusion chain around anchoring / scaling / "wOBA" that
cost a round-trip and that the next agent must not re-enter.** Companion memory: `cwhit-program-batch-state`.

Branch `cwhit-scorecard-p1p2`, commit `1e9bc27` (P1+P2). Later work uncommitted.

---

## 0. TL;DR

- **P2 delivered.** `tests/baserunning-invariants.test.ts` — 9 tests, each verified by reintroducing the bug.
- **P1 delivered.** The benchmark scorecard exists and ran on **all 5 Quick tiers × both roles** (I captured
  the missing 8 fixtures by hand).
- **THE HEADLINE: cwhit's advantage is LEVEL and SPACING, not ORDERING.** 0 CI-clear shape wins for us,
  7 CI-clear losses, **all noise-scale** (corr .96 vs .97). ⇒ **P4 / two-argument M8 = NO-GO on this evidence.**
- **v1's "his model wins BB9/HR9/BABIP" was a LEVEL result misreported as model quality.** The two-axis split
  dissolves it. This is the work-order's methodology fix landing exactly as predicted.
- **The window-overlap confound RUNS THE WRONG WAY** — bronze (least in-sample, 60%) is where his edge is
  LARGEST. His level edge is a genuine frame effect, not memorization. Do not discount it as an artifact.
- **DEREK'S RULING (kills most of P3 as written): levels are a CONVENTION, not a defect.** See §3.
- **DEREK'S FOCUS: EVENTS, and whether we systematically mis-value PLAYER TYPES (e.g. HR hitters).** See §5.
  This is the live question. Not levels. Not composites.
- **The live defect is SPACING**: 0 wins / 17 losses; K9 spread 0.52–0.66 against corr 0.95.

---

## 1. What shipped

**P2 — `tests/baserunning-invariants.test.ts`** (9 tests). Pins: (1) BsR centered on the HITTER pool mean;
(2) anchor/calibration invariant to the BsR toggle; (3) BsR applied OUTSIDE sFinal. Each was verified by
reintroducing the original bug: no-centering reproduces the exact **+9.38 mwOBA** uplift; whole-pool centering
gives **+2.90**; `(batting+bsr)*sFinal` gives **9.1 mwOBA** of tier-dependent drift; an Offense-selecting
anchor shifts sFinal **1.87e-3**. A spread assertion catches the zeroed-term case a mean-only test would pass.
Finding worth carrying: **the handoff's "+9.4 uplift" IS `brCenterHit`** — bug 1 was *no centering at all*;
the hitter-vs-whole-pool distinction is a **separate, smaller (~2.9 mwOBA)** defect in the same term.

**P1 — the benchmark scorecard.** `tools/cwhit-scorecard.ts` + `src/eval/cwhit/scorecard.ts` +
`src/eval/cwhit/sample.ts` (the shared judged-sample builder — ONE home, both drivers import it; extracted
rather than copied, and the scorecard's output verified byte-identical across the extraction).
Supersedes `tools/cwhit-triangulate.ts`.

**Data — `fixtures/cwhit-proj/cwhit-{iron,bronze,silver,gold,diamond}-{pit,hit}-proj.tsv`** (10 files).
Hand-transcribed top-100 snapshots. Notes for whoever captures next:
- The site moved: the landing page proxies to **`https://app.cwhitstats.com/stats/`**.
- **There is no CSV export.** `get_page_text` + "Show 100" is the only path; each table is one read.
- Each table states **its own model training window**, which differs per tier — parsed into the fixture
  headers. Overlap with the judging window: **bronze 60%, iron 87%, silver/gold/diamond 100%** (diamond's
  model trained over 62 days). This variation is *leverage*, not just a caveat — see §2.
- Pitcher files have a 1-line `#` header; hitter files have 2. Parse all leading `#` lines as comments.

---

## 2. Scorecard results

Method: LEVEL = mean(pred−obs) ±95% CI. SHAPE = de-meaned agreement, verdict read off **corr only** (scale-free
⇒ answers "who orders the cards better" = the M8 question). SPREAD = SD(pred)/SD(obs), with binomial
deconvolution. DUEL CIs = 2000-rep **paired** bootstrap (same cards ⇒ shared card difficulty cancels).

**SHAPE — the M8 axis.** WE WIN: *(none)*. WE LOSE (CI-clear): iron pit BABIP (−0.044), iron hit HR600
(−0.061), bronze hit SO% (−0.009), bronze hit BABIP (−0.044), silver hit SO% (−0.012), gold pit BB9 (−0.018),
diamond hit wOBA (−0.337). Everything else TIES. **All losses are noise-scale** (corr .96 vs .97) except the
diamond-hit composite at N=17. **BABIP is the only channel with a consistent shape story** (negative at every
tier, replicated across roles) — and even it is small. ⇒ **P4 NO-GO.** A two-argument matchup model is a large
build justified by a frame-shape gap that mostly isn't there.

**K — our supposed win, correctly characterised.** We beat him on K9 LEVEL at iron/bronze/silver/gold
(Δ|level| −0.29..−0.87); he runs hot **+0.95..+1.04 at every tier** = a flat additive bias in HIS model.
But K9 **SHAPE TIES everywhere**. ⇒ **we do not order K better; we center it better.** And our K9 spread is
0.52–0.66. The K "win" was a level win sitting on a spacing defect.

**SPREAD.** We win **0** rows, lose **17**. Scale-free ⇒ unaffected by everything in §3.

**IRON GATE: PASS.** No frame breakdown at k≈1.6–2.2. N=44 (best pitcher depth of any tier); shape strong and
in line with bronze (K9 .979, BB9 .973, HR9 .881, BABIP .877); levels track bronze's signs and magnitudes.
Iron is our *strongest* K9 level tier. Its only negative (BABIP shape) is present at every tier.

**DIAMOND PIT — DEAD PREDICTION.** N=1 well-sampled card. Only 18/123 tournaments covered ⇒ per-card IP never
reaches the bar. **Unrecoverable by paging** (85–99% of those rows are already below it). Needs more cwhit
*instances*, not more rows.

**WINDOW CONFOUND — falsified as the explanation.** If in-sample fitting bought his edge, the edge must rise
with overlap%. It doesn't: `corr(overlap%, his edge)` is ≤0 on nearly every pitcher channel (BB9 −0.42,
BABIP −0.52/−0.85, wOBAA −0.72/−0.74), and **bronze — the LEAST in-sample tier at 60% — is where his BB9,
BABIP and wOBAA edges are LARGEST.** ⇒ his level edge is a real frame effect (he fits tournament data, we fit
league). Confound-consistent exceptions to discount: hitter BB% level (+0.84), pit HR9 shape (+0.85), hitter
wOBA shape (+0.66).

**Two methodology bugs the tool fixed** (both would have corrupted the shape verdict):
- It had used a **fixed 0.30 XBH share**, erasing exactly the card-to-card variation the wOBA shape verdict
  judges. His `XBHpct` is measurably **(2B+3B+HR)/H** (slope 1.027, corr 0.996 vs an independent recon; the
  per-AB/per-PA readings fail at corr 0.87).
- The **K/AB→K/PA** conversion now folds in the sac term (`1−BB−HBP` minus the exact identity is a consistent
  −0.0124): mean|err| 0.0057 vs 0.0262 = **4.5× tighter**, and row-specific.

---

## 3. ⚠ THE ANCHORING / SCALING / wOBA CONFUSION — read this before touching the eval

I got this wrong **twice** in one session. Both errors are in the transcript; both are recorded here so the
next agent doesn't repeat them. Derek caught both.

### 3a. "deployed" in the cwhit tool names does NOT mean the deployed scoring path

`tools/cwhit-audit-deployed.ts` — the tool whose result memory records as the **"DEPLOYED AUDIT"** with the
**"+18 mwOBA uniform residual"** — contains **no** reference to `calibrate`, `calScales`, or the `trusted*`
path. **"Deployed" in that filename has only ever meant "own-gap applied."** The new scorecard inherited the
convention. **The only genuinely deployed-faithful cwhit tool is `tools/cwhit-bsr-validate.ts`**, which does
`calibrate(basePool, {coeffs, derived, eventForm, poolTransform})` and reads `scoreCard(c, cfg).hit.bsr600`.
⇒ Treat memory's "+18 mwOBA" as a **raw event-model** number, not a shipped-score number.

### 3b. MY ERROR: sBB/sHR are NOT applied by the deployed model — they are retired

I read `src/scoring-core/woba.ts` (`trustedHittingWoba` → `hittingComponents(e, sBB, sHR, ...)`), saw per-event
BB/HR scales, and told Derek the eval was omitting them. **Wrong.** One file upstream,
`src/scoring-core/calibrate.ts` says:

```
// PER-EVENT CALIBRATION (sBB/sHR) — REMOVED under #2. Its job (pull the field's BB/HR
// to the league baseline = crude pool-relativity) moved to the rating-space pool
// transform; ... So with #2 these are 1 ... log-linear path keeps them (parity).
const noEvCal = !!eventForm;
const hitBBScaleVR = noEvCal ? 1 : evScale(...)   // ditto hitHRScale*, pBBScale, pHRScale
```

The deployed model is raw-poly ⇒ `eventForm` is present ⇒ **`sBB = sHR = 1`**. They live **only** on the
retired log-linear parity path (CLAUDE.md: log-linear is out of production; memory `m6-retirement-state`
lists "full log-linear removal" as *deferred cleanup* — i.e. **this repo still contains live-looking dead
code, and `woba.ts` reads as if the mechanism were current**).

**Derek's correction, which is the right mental model: own-gap IS the successor to the per-event BB/HR
calibration.** Same job, moved from event space to rating space. They are **not** two corrections to stack.

### 3c. What the eval tools therefore actually omit: only `sFinal`

`sFinal` (`hitScaleVR/VL`, `pitchScale`/`pitchScaleVR/VL`) multiplies the **assembled** wOBA.
Consequences, all of which favour the existing results:
- It **never touches channels** ⇒ **every channel finding stands** (HR, BB, K, BABIP, the two-ledger verdicts).
- It **cannot move ordering** (one positive scalar per tier×side = a monotone rescale) ⇒ **shape/M8 verdicts stand.**
- It **cannot move spread ratios** (scale-free) ⇒ **the spacing defect stands.**
- It moves **only** the composite level (hitter wOBA, pitcher wOBAA) — which per §3d is not a defect anyway.

My claim that the elite-power HR cliff was "probably an `sHR` artifact" is **RETRACTED**. It was a
dead-code read, not a data problem.

### 3d. DEREK'S RULING — the anchor is a CONVENTION, not a prediction

Verbatim in substance: *"I don't actually care about target_woba in this manner or how well we match cwhit
projected wOBA, only relative (ex: pearson). It's interesting to look at our raw but we don't really want to
scale/anchor here — that's just for my own use and for our optimizer in caps."*

- `TARGET_WOBA` / the anchor = a **readable scale** + the **cap optimizer's budget unit**. Not a claim about
  the world. ⇒ "our wOBAA level is +0.019 off observed" is a **unit mismatch, not a defect**.
- ⇒ **The P3 "close the level gap" program is DROPPED as written.** Do not resurrect it without Derek.
- ⇒ **Keep the eval on the RAW (unanchored) quantity.** Do not add an sFinal-scaled composite.
- Note the anchor already handles **cross-pool comparability by construction**: `hitScale` and `pitchScale`
  both normalize to the **same** `TARGET_WOBA`, so the raw hitter-vs-pitcher level asymmetry (hitter wOBA
  ~0.000 vs pitcher wOBAA +0.019) is **absorbed**. I nearly proposed a fix for this. It needs none.
- **"Relative" ≠ Pearson alone.** It means ORDER *and* SPACING (two-axis doctrine). Spacing is where we lose.

### 3e. The three metrics — do not conflate (this trips everyone)

- **Offense** = wRAA + BsR, wOBA-scale. What `valueFor` + the **optimizer** consume. `scoreCard.hit.offense_*`.
- **wOBA** = batting-only, real wOBA. **The like-for-like metric vs cwhit and the real world.** `hit.woba_*`.
- **BsR** = baserunning runs/600, side-invariant. `hit.bsr600`.
- **cwhit's wOBA is BATTING-ONLY** (confirmed two ways). The eval uses our batting-only `woba_*`. Any future
  deployed-vs-cwhit comparison must either add his `wSB600+UBR600` or stay batting-only.
- Pitcher `pitch.woba_*` is genuine wOBA-against (no baserunning).
- **His `pwOBA` column is NEVER used as truth** — wOBA is recomputed from his raw events with OUR weights.

---

## 4. The two-ledger diagnostic (uncommitted)

`tools/cwhit-two-ledger.ts` + `src/eval/cwhit/two-ledger.ts`. Built because Derek's steer was **"fix the
CHANNELS, not the composite."** Measurement only, no fitting.

**Ledger checks — clean; a unit error is ruled out.** The repo's ghost detector (`detectContamination`)
**cannot** run on cwhit data (needs per-row paired PA/BF + ORG; cwhit publishes per-card aggregate rates, no
ORG, no BF). Stated in-tool, not skipped. What ran: **BF/9** measured 38.84–39.15 (upper bound; DP/CS pull it
down ~1.0–1.5) ⇒ 38.7 (i.e. BF≈IP×4.3) is inside the plausible band at every tier. **The decisive test:** the
BF/9 needed to zero K9/BB9/HR9 is 35.6/30.5/32.0 — a **5.1–7.7 unit spread**, so **no single scalar works**;
and BABIP is BF/9-invariant yet still biased +0.005..+0.012*. Hitter over-identification: OBP rebuilt from the
rate columns lands +0.0010..+0.0016 off his published OBP = the expected sac term, balancing at all 5 tiers.

**Attribution — reconstructs exactly; the cancellation is confirmed; MY STATED MECHANISM WAS WRONG.**
Pitcher **UNEXPLAINED = +0.0 at all four tiers** (method self-check passes).
Hitters (mwOBA, iron): BB **+3.3\***, SO **−7.5\***, HR **−2.1\***, BABIP **+8.9\*** → Σ +2.7 vs measured +1.0 (n.s.).
⇒ **~22 mwOBA of channel error nets to +1.0. The hitter composite is right BY LUCK.**
But the dominant pair is **BABIP(+8.9) vs K(−7.5)** — *not* "BB up vs K/HR down" as I told Derek. BB is a
third of BABIP; HR is minor. **And K is NOT weightless for pitchers**: it contributes **−4.4..−5.5 mwOBA**
indirectly (more K ⇒ fewer BIP ⇒ fewer hits). The conclusion survives (pitcher BB/HR/BABIP each ~+6..+9.5
swamp K ~3:1 ⇒ no cancellation); **the premise I gave for it did not.**
Hitter UNEXPLAINED is CI-clear only at gold (−2.0\*) = the hit-mix channel the four headline channels can't see.

**Two-ledger test** (hitters and pitchers are two views of the SAME games ⇒ a real frame effect must agree in
sign from both sides; put both in a common per-PA/per-BF unit):

| channel | verdict |
|---|---|
| **BABIP** | **PASSES** — 4/4 tiers agree on **sign AND magnitude** (diff CI covers 0 everywhere). Strongest result; also BF/9-exempt. |
| **BB** | **PASSES on sign** 4/4 — but magnitudes differ CI-clear at iron/bronze/silver (**2.2× / 3.7× / 2.1×**; hit +0.006..+0.013 vs pit +0.015..+0.023). A real frame effect hitting the roles **unequally** ⇒ NOT one shared constant. |
| **K** | 3/4 agree; gold inconclusive (pit K9 −0.10 n.s.). |
| **HR** | **FAILS** — 3 sign flips, 1 inconclusive. |

**Selection hypothesis — REFUTED (my theory, killed by the data).** I had proposed that the HR sign flip and
part of the pitcher wOBAA constant were our spread compression seen through a top-100-by-usage elite tail.
- **Pitcher wOBAA = a REAL FLAT CONSTANT ≈ +0.016–0.017** (raw/unanchored). Quartile bins flat (iron
  +0.019/+0.023/+0.023/+0.015, all CI-clear); FLAT at 3/4 tiers; `constAtPool` +0.016\*/+0.016\*/+0.017\*.
  The only BOTH verdict is silver, which is the untrustworthy cell (range 46%, `extrap=YES`).
  **(Per §3d this is a convention question, not a defect — recorded for completeness only.)**
- **HR is two unrelated phenomena, not one effect seen from two sides.** Pitcher HR9: bins
  +0.25/+0.15/+0.20/+0.14 ⇒ essentially **flat**, a real constant (+0.14\* at iron/bronze). Hitter HR600:
  bins iron +0.17/+0.77/−0.77/**−5.48\*** ⇒ a **top-quartile CLIFF**, Q1–Q3 ≈ 0, same shape at bronze/silver/gold.
  ⚠ The tool's own guard applies: **the hitter-HR bins are non-monotone, so the linear `constAtPool` split for
  hitter HR MUST NOT be quoted.**

**Top-100 selection — NOT binding where it matters (surprise).** Per-channel range = **106% of pool SD on
average** (min 52%, max 148%); **0 of 36 cells extrapolate**. Usage-selection is only loosely tied to any *one*
channel ⇒ the top-100 already spans the pool range. **Per-channel verdicts are measurements; ranks 101–300
would not change them.** It *is* binding on the **composites** (range 61%, |displacement| 1.59 pool SD, 5/9
extrapolate) — usage-selection ≈ overall-quality selection. Derek's note for the record: *"'we're only testing
top 100' is true, but nothing we're doing is a set-in-stone rule if we decide it's wrong"* — i.e. deeper
capture is available if it ever binds.

**Data ask, prioritised:** (A) **diamond + gold Quick pitchers — more INSTANCES, not more rows** (dead/thin
cells; unrecoverable by paging; ceiling is cwhit's crawl cadence). (B) ranks 101–300 for the 5 extrapolating
composite cells, ~2 pages each — buys **only** the composite decomposition (low value under §3d).
(C) **Do not** spend captures widening per-channel range; already pool-wide.

---

## 5. ⭐ DEREK'S FOCUS — EVENTS, and TYPE bias. This is the live question.

Verbatim in substance: *"events are the main focus right now, because I'm worried we're undervaluing or
overvaluing certain types of players (ex: HR hitters)."*

This is **not** the level question and **not** a global-spread question. It is: **does our event model
systematically mis-value particular player ARCHETYPES?** The evidence already on hand that speaks to it:

- **Elite HR hitters are under-valued.** Hitter HR600 bias is ≈0 through Q1–Q3 and **−5.48 at Q4**. In a
  level-free frame this is a **spacing/type statement**: we under-separate the top of the power distribution.
  **This is Derek's example, and the data supports it.** (Confirmed to be measured **after** own-gap lifts the
  Power rating — see §3b; own-gap is the only HR scaling the current model has.)
- **High-stuff pitchers are under-credited** — memory `overscoring-stuff-residual`: within-tier partial slope
  **+1.53 mwOBA per +10 stuff**, CI-clear, **survives own-gap**. Low-stuff/high-control cards are net
  over-valued (the logged Donohue case). Corroborated within-frame by the v5 variant audit (v5 Stuff boost
  yields ~0.1–0.15 fewer K9 than observed).
- **Hitter archetype slopes** (earlier audit, own-gap-confounded ⇒ medium confidence): eye **+0.77\***
  (over-credit walks) vs pow **−1.42\***, kRat **−1.24\***, babip **−1.66\*** (under-credit the real skills).
  **Same passive-vs-power shape as the pitcher stuff story.**
- **The unifying hypothesis worth testing:** these are all one defect — **we compress the elite tail of each
  rating axis**, so "extreme" archetypes (big power, big stuff) get pulled toward the field and "safe" ones
  (walks, control) get pushed up. Under Derek's framing this is a **valuation** problem, which is exactly what
  the optimizer consumes.

**IN FLIGHT (agent `ad8e22685e4015b5a`, resumable):** the spacing/calibration battery. Its core is
**the MMSE test, which decides whether the compression is legitimate**:
> An optimally-shrunk MMSE predictor satisfies **SD(pred)/SD(obs_true) ≈ corr**. Iron K9 has **corr 0.951 but
> a spread ratio of 0.54** ⇒ 0.54 ≪ 0.95 ⇒ **over-shrunk, not optimally shrunk**. Equivalently the calibration
> slope of obs~pred = corr ÷ ratio ≈ **1.76** (should be 1.0 if calibrated) ⇒ **we under-react ~1.8×**.
> Deconvolution can't rescue it (K9 sampling noise is only 2%).
It also asks: **is the under-reaction FLAT across the quality range, or concentrated at the top?** Flat ⇒ a
scalar per channel could fix it. Tail-concentrated (which the HR quartile pattern suggests) ⇒ it is a
**curve-shape problem at the top of the rating** and a scalar is the wrong instrument. Plus: cwhit as a
reference column (his K9 ratio ~1.15 — is ~1.0 achievable on this data?), and a ranking of channels by how
much spacing error each contributes **to the value metric** (a badly-compressed channel that barely moves
value isn't worth a retrain cycle).

---

## 6. Open questions / traps

1. **The HR sign contradiction is UNRESOLVED.** Memory `quicks-null-test-and-format-effect` records a
   universal format bias **HR×0.87** (observed HR *below* expectation). The scorecard has hitters observed
   *above* our prediction. **These point opposite ways.** Different windows/samples, so not necessarily a
   contradiction — but **do not fit any HR term while two measurements disagree on the sign.**
2. **kSpread / stuff-slope are NOT protected.** Derek, verbatim: *"'settled dead' was an AI choice, I have no
   strong opinion."* ⇒ they are reopenable on evidence, and the 0-for-17 spread record plus the MMSE test are
   candidate evidence. **But** memory's parking rationale ("form is maxed": full-rawquad tops at 0.76 in-frame,
   BB must stay log or it fails the deploy vertex gate) was a statement about **what the current form family
   can express**, not about what is true. If compression is elite-tail-concentrated, re-examine that rationale
   rather than inheriting it.
3. **Diamond pitchers are dead** (N=1) and **gold is thin** (N=15). The pitcher two-ledger and the pitcher
   tier gradient both stop at gold. No 5th-tier pitcher claim exists in either direction.
4. **`detectContamination` cannot run on cwhit data** (shape mismatch). The ledger was verified by other means
   (§4). Don't assume the ghost detector covers this source.
5. **cwhit conventions**: SO% = **K/AB** (ours K/PA) — confirmed, not a bug. `XBHpct` = **(2B+3B+HR)/H** —
   measured, not assumed. Projected HR is **per-PA**; observed is **HR600**. His projected tables are
   **top-100 by pwOBA over the whole pool** while observed is **top-100 by IP** ⇒ ~596 projected rows have no
   observed line (structural, not a join defect).
6. **Only 4 usable tiers for the overlap probe**, and overlap is nearly constant (87–100%) outside bronze,
   and tier co-varies with pool strength ⇒ the probe is **directional, not a controlled test**.
7. **This repo contains live-looking dead code** (log-linear/parity remnants; `m6-retirement-state` lists the
   removal as deferred). **Before asserting any scoring path is live under raw-poly, check whether it is
   gated on `eventForm`.** That is the exact trap §3b fell into.

---

## 7. Files

- **Committed (`1e9bc27`, branch `cwhit-scorecard-p1p2`)**: `tests/baserunning-invariants.test.ts`;
  `src/eval/cwhit/scorecard.ts`; `tools/cwhit-scorecard.ts`; `src/eval/cwhit/parse.ts` (mod);
  `fixtures/cwhit-proj/*.tsv` (10).
- **Uncommitted**: `src/eval/cwhit/sample.ts` (shared judged-sample builder — extracted from the scorecard,
  output verified byte-identical); `src/eval/cwhit/two-ledger.ts`; `tools/cwhit-two-ledger.ts`;
  plus whatever the in-flight spacing agent lands.
- 310 tests green; `npm run typecheck` clean.
