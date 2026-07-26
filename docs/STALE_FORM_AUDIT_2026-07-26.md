# Stale-form audit — 2026-07-26

**Scope.** Follow-up to `docs/CONSISTENCY_SWEEP_2026-07-25.md` Finding 5. Production ships
`DEPLOYED_FORMS = { hit: RAWPOLY_HIT, pit: PARETO_PIT, pinned: true }` (`src/training/forms.ts:724`).
Zero of the 147 files in `tools/` import it. **47 of them construct or pin an event form by hand.**
This document triages which committed conclusions were computed against a form we do not ship, and
which of those are load-bearing for something currently deployed.

**Method.** Source inventory of all 47 fitters; citation trace of each tool name across `docs/`,
`src/`, `fixtures/`, `tests/`, `web/`, the program memory record and every commit message; a pin
census run over five league windows; and four tools re-run under the deployed configuration with
OLD → NEW on their headline numbers. No repo file was modified except this one; no fixture was
regenerated; no production default was touched. Probe scripts were written to the session scratchpad.

---

## Headline

**No shipped constant is exposed.** `PINNED_HIT_TAIL` — the one shipped constant whose cited
provenance is a hand-form tool — is clean on **two independent grounds** (§1). It leads this document
because it was the open question, and the answer is a clear negative.

**No committed fixture is exposed either.** Only **4 of the 47** hand-form tools have a committed
artifact in `fixtures/`, and all four are correct-by-construction or deliberately frozen (§2).

**What *is* exposed is a set of numbers transcribed out of fixture-less tools into `docs/` and the
program memory record**, where they are still quoted as *"the deployed model's"* baseline. Two of
them were re-run and moved materially (§4). The exposure is on the pitcher K/HR/H channels only, and
it is the `STUFFAUG_PIT` → `PARETO_PIT` axis, not the pinning axis.

---

## Ranked table

`Form` = what the tool actually builds. `Pin?` = whether it passes a pin collector.
`= deployed?` = whether the fitted model equals what `server.saveTrainedModel` would produce.
`Change?` = could the tool's conclusion actually move.

### Tier 1 — exposed AND cited with numbers that are still quoted as production's baseline

| # | Tool | Form built | Pin? | = deployed? | Fixture? | Cited where | Change? | Verified |
|---|---|---|---|---|---|---|---|---|
| 1 | `hitter-tails.ts:73` | `STUFFAUG_PIT` labelled *"PIT deployed(K=log)"* | no | **NO — pit k/hr/h** | no | plan §11.28; memory `tournament-opponent-frame` | **YES — measured** | ✅ §4.1 |
| 2 | `ceiling-test.ts:89` | `STUFFAUG_PIT` labelled *"deployed (StuffAug, K=log)"* | no | **NO — pit k/hr/h** | no | plan §11.26 + the §15.8 provenance amendment (l.1639) | **YES — measured** | ✅ §4.2 |
| 3 | `family-twoaxis.ts:105` | `STUFFAUG_PIT` as the *"deployed"* baseline row | no | **NO — pit k/hr/h** | no | plan §11.24 (`rawquad_pit 0.76`), memory `cwhit-program-batch-state` | **YES — same instrument as 1–2** | inferred |
| 4 | `context-invariance.ts:36` + header | `{bb:R2,k:R2,hr:R2,h:R2,stuffAug}` called *"the adopted form"*; header quotes *"Deployed … in-frame ~0.62"* | no | **NO — BB is quad, deployed BB is log; and 0.62 is StuffAug's** | no | plan §11.29, memory `overscoring-stuff-residual` | **YES — label + baseline both wrong** | inferred |

### Tier 2 — form mismatch is real but the conclusion is structurally insulated

| # | Tool | Form built | Pin? | = deployed? | Fixture? | Cited where | Change? | Why cleared |
|---|---|---|---|---|---|---|---|---|
| 5 | `env-neutralize-check.ts:53` | `STUFFAUG_PIT` | no | NO | no | plan §8b; memory `tournament-model-env-handling` | **NO** | pitcher form is the *same object* in both arms and the tool says so (`:52` "it cancels"); the measured contrast is hitter-only |
| 6 | `phase1c-hitter-report.ts:40` | `STUFFAUG_PIT` | no | NO | no | memory `tournament-opponent-frame` | **NO** | conclusions are hitter-side; pitcher form is a nuisance constant |
| 7 | `bbhr-anchor-impact.ts:28` | `RAWPOLY_PIT` (never deployed; no Stuff aux) | no | **NO — incl. BB (aux absent)** | no | memory `pool-adjustment-rating-vs-event-space` (`sBB 0.93 / sHR 0.94`, top-26 overlap 96%) | **possible** | flagged, not re-run: pre-dates the pareto; anchor scalars are ratios, largely form-cancelling |
| 8 | `leaguenorm-audit.ts:59` | `RAWPOLY_PIT` | no | NO | no | memory `m6-phase1-integration-plan` ("leagueNorm DROP CONFIRMED") | historical | decision predates `PARETO_PIT` (2026-07-14); correct as run |
| 9 | `tournament-matchupk.ts:51,62` | `STUFFAUG_PIT` | no | NO | no | `fixtures/bakeoff-parity-scoreboard-2026-07-25.txt:47` | **NO** | **FROZEN ON PURPOSE** — `forms.ts:803-809` documents that re-basing would redefine what the candidate measures |
| 10 | `pithr-form-bakeoff.ts`, `diag-pithr-2043.ts` | `PARETO_PIT`, explicit `pinned=false` | explicit | deliberate | **yes** | `forms.ts:120`, `server.ts:1642`, `tests/vertex-pin.test.ts` | **NO** | **FROZEN ON PURPOSE** — their job is to exhibit the unconstrained vertex |

### Tier 3 — right form, only the pinning axis differs

Thirteen tools hand-rebuild a literal `{ ...STUFFAUG_PIT, bb: LOG, k: R2, hr: R2, h: R2, stuffAug: true }`.
**That literal is structurally identical to `PARETO_PIT`** (verified: `LOGc === {kind:"log"}`,
`R2 === {kind:"rawpoly",degree:2}`, `hBip` absent in both). So these tools build the *right* form; the
only gap is the pin collector — and the pin census (§3) shows the pin cannot fire on the window these
were run against.

`con-overvalue-check.ts:42` · `eb-elite-spread.ts:38` · `fade-microstudy.ts:40` ·
`h3-eghitter-decomp.ts:38` · `p1-winner-vs-pareto.ts:39` · `p3-pitch-info.ts:38` ·
`p4-quad-amplification.ts:36` · `p5-bronze-adjudicator.ts:39` · `phase1c-b3-edgelevels.ts:40` ·
`phase1c-b4-monotone.ts:30` · `phase1c-joint-run.ts:47` · `satbb-bakeoff.ts:42` · `synthetic-recon.ts:40`

Empirically verified on `con-overvalue-check.ts` (§4.4): pinning moves the headline by ≤ 0.16 mwOBA
and changes nothing. **Cleared.**

### Tier 4 — no committed artifact, nothing cited with numbers, low priority

`tournament-bb.ts` · `tournament-compare.ts` · `tournament-cv.ts` · `tournament-train.ts` ·
`tournament-bipfix-validate.ts` (all `STUFFAUG_PIT`) — cited only by the consistency sweep that
found them, or by methodology mentions carrying no number.

`weight-sweep.ts` · `window-length.ts` · `pool-transfer.ts` · `pool-scale.ts` · `pool-fake.ts` ·
`log-vs-linear.ts` · `per-league-fit.ts` — all pre-M6, all using `RAWPOLY_*`/`LOG_*`, and
`docs/REBUILD_ROADMAP.md:933` explicitly classifies them as **"Diagnostic tools (throwaway)"**.

`hr-and-transform.ts` · `quad-needs-transform.ts` · `phase1c-b1-cv.ts` · `phase1c-b2-pareto.ts` ·
`phase1c-framev2-kspread.ts` · `pit-channel-locator.ts` · `tournament-exposure-stress.ts` ·
`insample-frame-check.ts` — see the cleared list (§5).

**That is 30 tools with no committed artifact and no number-bearing citation.** Stated as a result,
not an omission.

---

## 1. `hit-tail-bakeoff.ts` and `PINNED_HIT_TAIL` — CLEAN, on two independent grounds

`src/scoring-core/hit-tail.ts:8` and `src/server/server.ts:496` both name this tool as the evidence
for `PINNED_HIT_TAIL` (λ = 2.20 HR / 1.10 BABIP / 0.30 SO), the operating point that ships in **all**
tournament scoring. The consistency sweep flagged `fitHitForm(RAWPOLY_HIT, …)` at lines 569, 609 and
633, all unpinned, and correctly recorded that its exposure on the bake-off's own window was
unverified. It is now verified.

**Ground 1 — the λ fit never touches `fitHitForm` at all.** The constants come from candidate A
(gap-conditioned event-space corrections), which is fit on `rows0` (`:518`), and `rows0` is built
from `deps0 = makeDeps(trained.eventForm)` (`:133`) — the **deployed artifact's own fitted event
form**, read off `data/trained-models/*.json`. Every λ in `fitLambda(rows0, …)` (`:545`, `:783`) is
therefore computed against exactly what production scores with, pins included, by construction.

The three `fitHitForm` calls are confined to **candidate B**, the *rejected* form-change alternative:
- `:569` — the B0 sanity check, which compares a refit to the artifact and printed
  `max |refit hr β − deployed hr β| = 0.000000 (EXACT)` in **both** committed runs;
- `:609` — candidate-B league OOT (B-hrlin / B-hrcub / B-h2 / B-hrcub-h2);
- `:633` — candidate-B cwhit rebuild.

Nothing that flows into `PINNED_HIT_TAIL` passes through them.

**Ground 2 — `RAWPOLY_HIT` does not pin on any league window, ever.** Pinning fires only when a
degree-2 rawpoly channel's unconstrained vertex lands strictly inside the observed z-domain.
`RAWPOLY_HIT` has exactly one quad channel (`hit.hr`; bb/k/xbh/h are all log). Measured on the
bake-off's own window and on every other window the loader can build:

| window | `hit.hr` vertex | z-domain | pins |
|---|---|---|---|
| **2041+2042** (the bake-off's own, `trained.window` at run time) | out of domain | [−3.846, 2.056] | none |
| 2042+2043 (current active) | out of domain | [−3.739, 2.397] | none |
| 2040+2041 | out of domain | [−4.460, 2.030] | none |
| 2039+2040 | out of domain | [−4.345, 2.024] | none |
| 2037+2038 | out of domain | [−4.131, 1.992] | none |

`hit.hr` fitted β is byte-identical pinned vs unpinned on all five windows (e.g. 2041+2042:
`[15.7857, 3.2480, −0.3757]` both ways). This independently reproduces
`fixtures/bakeoff-parity-scoreboard-2026-07-25.txt` §3.

> **Verdict: `PINNED_HIT_TAIL`'s provenance is not corrupted, and would not have pinned differently
> under the deployed configuration on its own fit window. The shipped constant stands as fitted.**
> The λ constants are also not re-derivable from a form change, because they were never derived from
> a hand-built form.

---

## 2. Every fixture-backed fitter is clean

Of the 47 hand-form tools, only **four** have a committed artifact:

| Tool | Fixture | Status |
|---|---|---|
| `hit-tail-bakeoff.ts` | `hit-tail-bakeoff-run-2026-07-16.txt`, `-2026-07-17-pinned.txt` | **CLEAN** — §1 |
| `bakeoff-parity-scoreboard.ts` | `bakeoff-parity-scoreboard-2026-07-25.txt` | **CLEAN** — passes fresh pin collectors (`:138,:144,:332,:369`); this is the tool that *found* the parity defect |
| `hitter-eyeaug.ts` | `hitter-eyeaug-2026-07-25.txt` | **CLEAN** — `fitHitForm(fm, tr, 0.75, pins)` (`:73`), `hitFormModel(…)` pinned default (`:273`); hitter-only, and `RAWPOLY_HIT` never pins anyway |
| `pithr-form-bakeoff.ts` | `pithr-form-bakeoff-run-2026-07-21.txt` | **CLEAN / deliberate** — `PARETO_PIT` with pins at `:75`, explicit `pinned=false` at `:125` because exhibiting the unconstrained vertex is its entire purpose |

Three further tools own fixtures but build **no** form — they read the deployed artifact directly:
`hitter-residual-channels.ts`, `stuff-residual-channels.ts`, `opponent-within-cell.ts`. Their
mentions of `RAWPOLY_HIT` / `STUFFAUG_PIT` / `PARETO_PIT` are prose in `say(...)` strings describing
the *secondary* `analyzeResiduals` instrument — and `src/training/residuals.ts:85,90` now reads
`DEPLOYED_FORMS` (fixed in 7c8a061, guarded by `tests/deployed-forms.test.ts`). **Clean.**

The BUILD-3 constant-producing tools (`fit-kspread-pit.ts`, `fit-kspread-c3.ts`, `fit-hrspread-c6.ts`,
`fit-pitspread-hrbab.ts`, `kramp-gap-trace.ts`, `tournament-kslope.ts`) build no form at all — they
read `trained.eventForm` off the active artifact. Re-confirmed. `K_SPREAD_PIT` and `PIT_SPREAD_HR`
are unaffected.

---

## 3. Pin census — where pinning can and cannot matter

Pinning fires only where a quad vertex lands in domain. Measured across five windows × four forms:

```
window      form              pins                     |Δ| vs unpinned
2037+2038   all four          — none —                 0
2039+2040   all four          — none —                 0
2040+2041   all four          — none —                 0
2041+2042   all four          — none —                 0
2042+2043   RAWPOLY_HIT       — none —                 0
2042+2043   STUFFAUG_PIT      — none —                 0   (all-log: pinEvent structurally cannot fire)
2042+2043   RAWPOLY_PIT       — none —                 0
2042+2043   PARETO_PIT        pit.hr @ z = 2.652       6.28e-4 wOBA (from the scoreboard fixture)
```

`pinZ = 2.652` matches `data/trained-models/league-42-43.json` `vertexPinned` exactly.

**Three cheap rule-outs follow, and they clear most of the field:**

- **R1 — `pinEvent` requires a rawpoly-2 channel.** `STUFFAUG_PIT`, `RAWPOLY_PIT`, `LOG_PIT`,
  `LOG_HIT`, `LOGCUBIC_*` carry none on the pinnable seats. For every tool using those, "unpinned" is
  a distinction without a difference. *(This alone clears the entire ~11-tool StuffAug group and the
  5-tool RAWPOLY_PIT group of the pinning charge.)*
- **R2 — `RAWPOLY_HIT` never pins on league data.** Verified on all five windows. Every hitter-side
  conclusion in `tools/` is therefore pin-clean, including `hit-tail-bakeoff`, `hitter-eyeaug`,
  `hitter-tails`' hitter rows, `hr-and-transform`, `tournament-exposure-stress`,
  `phase1c-hit-cancellation`.
- **R3 — the pin fires only on `[2042,2043]`.** The whole phase-1c battery ran while the active model
  was `league-41-42` (window 2041+2042), *and* vertex-pinning did not exist until 2026-07-21. Their
  as-run numbers are identical to what a pinned fit would have produced. The pin is a **re-run
  hazard, not a historical corruption**.

**Consequence: the pinning axis is not where the risk is.** The risk is `STUFFAUG_PIT` vs
`PARETO_PIT`, which differ on **k (log vs quad), hr (log vs quad) and h (log vs quad)** — and agree on
**bb (log + Stuff aux)**. So a tool analysing pitcher **walks**, or **hitters**, is unaffected; a tool
analysing pitcher **K, HR, hits or the composite value spread** is exposed.

---

## 4. Empirical OLD → NEW on the four verified cases

Each tool was copied to the scratchpad with imports rewritten and only the form line changed; the
original was run unchanged for OLD. Current window is `2042+2043` (active model `league-42-43`),
173 hitters / 149 pitchers at PA/BF ≥ 1000.

> **Reproducibility note.** These runs were made against the working tree as found at HEAD `91eff0b`
> **plus uncommitted concurrent edits** to `src/model/curves.ts`, `src/training/forms.ts` and others
> (an in-flight `HIT_HBP` / `hitHbpRate` consolidation and an optional H-channel aux). `RAWPOLY_HIT`,
> `PARETO_PIT` and `DEPLOYED_FORMS` were verified **unchanged** by those edits, and every OLD → NEW
> pair below was run against the *same* tree — so the contrasts are valid. Absolute levels may differ
> by a small amount from a clean checkout of `91eff0b`.

### 4.1 `hitter-tails.ts` — plan §11.28, the pitcher-form adoption CI. **BIGGEST MOVE.**

Only change: the `deplPit` baseline `STUFFAUG_PIT` → `PARETO_PIT` fitted pinned (= production).

```
                            OLD (STUFFAUG baseline)        NEW (deployed PARETO, pinned)
PIT deployed(K=log)  pooled 0.640                          0.777
PIT winner(rawquad+aux)     0.833                          0.833
paired-bootstrap CI:
  deployed            0.640 [0.568, 0.726]                 0.777 [0.683, 0.876]
  winner              0.833 [0.714, 0.961]                 0.833 [0.730, 0.941]
  Δ(winner − deployed) +0.192 [0.157, 0.233]               +0.055 [0.031, 0.081]
```

**The direction survives (still CI-clear), but the magnitude collapses by 3.5×.** The plan records
this contrast as *"deployed 0.623 → winner (rawquad-all+aux) 0.780, Δ +0.157 [0.129, 0.194] — CI
excludes 0. Materially + robustly better."* That was **correct as run** on 2026-07-14, when StuffAug
*was* deployed. It is no longer a statement about headroom above production. **Anything that reads
§11.28's Δ as "how much form improvement is still on the table" is overstating it by ~3.5×.**

Hitter rows are unchanged to the digit (`deployed RAWPOLY_HIT 1.014 / 0.928`, all one-channel flips
1.008–1.017) — R2 in action, and the *"log holds every seat"* verdict that keeps `RAWPOLY_HIT`
deployed is confirmed untouched.

### 4.2 `ceiling-test.ts` — plan §11.26, the "measured ceiling ≈ 0.78". **Production is already at the ceiling.**

Added `PARETO_PIT` unpinned and pinned alongside the tool's own two rows:

```
form                                all (N=149)          SP (N=13)          RP (N=70)
STUFFAUG  (tool label: "deployed")  0.64 [0.56,0.74]     0.73               0.64 [0.51,0.78]
PARETO_PIT unpinned                 0.77 [0.67,0.88]     0.87               0.78 [0.65,0.94]
PARETO_PIT PINNED (= production)    0.78 [0.69,0.88]     0.90               0.79 [0.63,0.97]
rawquad_pit                         0.83 [0.73,0.94]     0.95               0.84 [0.68,1.03]
```

Two readings:

1. **The §11.26 *verdict* survives intact.** Role-mix is still refuted (within-RP ≈ pooled under every
   form), and the form fix is still role-invariant. Nothing about the structural conclusion moves.
2. **The §11.26 *number* that gets quoted no longer describes production.** The plan's amendment at
   line 1639 hands forward *"MEASURED CEILING ≈ 0.78 … FORM decisions may continue to lean on ~0.78
   as the in-frame yardstick"*, against a status quo of 0.62–0.64. **The shipped pareto measures
   0.78–0.79 — it is *at* the quoted yardstick.** The 0.14-wide gap that motivated further form work
   no longer exists between production and the ceiling; what remains (0.78 → 0.83 against
   `rawquad_pit`) is the §4.1 Δ of +0.055.
   Pinning contributes 0.01 of that (0.77 → 0.78) — negligible, as R3 predicts.

### 4.3 `insample-frame-check.ts` — the frame-attribution proof. **CLEAN, and this one matters most.**

This is the only fitter cited from *shipped source*: `src/model/pool-transform.ts:181` and
`src/scoring-core/hit-tail.ts:13` both rest on *"in-frame K/hitters are already calibrated per
`insample-frame-check`"* — the premise that makes BUILD-1's K-spread ramp and BUILD-2's hit-tail
correction identity-at-gap-0 legitimate. Git shows it was **born with `PARETO_PIT`** (commit
`7dddbcd`, 2026-07-14) — the correct pair from day one. Its only gap is the pin collector.

OLD (unpinned, as committed) → NEW (pinned, = production):

```
HITTER — all four channels BIT-IDENTICAL (R2: RAWPOLY_HIT does not pin)
  HR ← Power         +0.04   | quartiles +0.16 −0.31 +0.06 +0.23      (unchanged)
  hits ← BABIP       −0.04   | −0.41 −0.08 +0.22 −0.12                (unchanged)
  uBB ← Eye          −0.14 · SO ← Avoid-K +0.15                       (unchanged)

PITCHER
  uBB ← Control      −0.13  (unchanged — BB is log+aux in both fits)
  K ← Stuff          +0.31  (unchanged)
  HR ← pHR           −0.05 overall, unchanged; quartiles move ≤0.03/600:
                       q2 −0.14 → −0.12 ,  q4 +0.04 → +0.01
```

**Cleared.** The load-bearing premise is unaffected; the largest movement anywhere is 0.03 HR per 600 BF.

### 4.4 `con-overvalue-check.ts` — the Tier-3 pareto-literal group. **CLEAN.**

The tool's local `PARETO` literal is structurally `PARETO_PIT`; only the pin collector differs.
OLD (unpinned) → NEW (pinned):

```
                          OLD            NEW
Bronze-t  HIGH con  VALUE +9.02 mwOBA    +9.18 mwOBA
EG-clean  HIGH con  VALUE +3.20 mwOBA    +3.20 mwOBA
Bronze-q  MID  con  VALUE +2.71 mwOBA    +2.74 mwOBA
uBB bias, all cells      Δ ≤ 0.25/600
```

Conclusion unchanged in sign, size and ordering. **Cleared — and by extension the other twelve
Tier-3 tools, which share the form and the pin exposure.**

*(Side observation, not a form issue: memory `overscoring-stuff-residual` records this as
"+7.0 Bronze-t / +3.3 EG"; today's re-run gives +9.02 / +3.20. That drift is the **window** — the
tool reads `trained.window`, which moved 41-42 → 42-43 — not the form. Per the "league frame
strengthens every window" note, that is the null, not a defect.)*

---

## 5. Explicitly cleared, and why

State these as results.

- **All hitter-side conclusions in `tools/`, everywhere, unconditionally.** `PARETO_PIT` and
  `STUFFAUG_PIT` differ only on the pitcher side, and `RAWPOLY_HIT` — the deployed hitter form — is
  what every hitter-fitting tool builds, and it never pins on any league window 2037–2043 (§1, §3).
  Covers `hit-tail-bakeoff`, `hitter-eyeaug`, `hitter-tails` (hitter rows), `hr-and-transform`,
  `phase1c-hit-cancellation`, `tournament-exposure-stress`, `phase1c-hitter-report`,
  `env-neutralize-check`, `bbhr-anchor-impact` (hitter leg), `insample-frame-check` (hitter leg).
- **All pitcher-BB conclusions.** The two forms agree exactly on `bb` (log + Stuff aux). Clears
  `con-overvalue-check`, `tournament-bb`, and the BB legs of `insample-frame-check` and
  `phase1c-b*`.
- **The entire pinning charge against the ~11 `STUFFAUG_PIT` tools and the 5 `RAWPOLY_PIT` tools.**
  Those forms carry no rawpoly-2 channel; `pinEvent` cannot fire (R1).
- **The entire pinning charge against the 13 Tier-3 pareto-literal tools.** They ran on window
  2041+2042, where no channel pins, and before pinning existed (R3). Verified end-to-end on
  `con-overvalue-check` (§4.4).
- **All four fixture-backed fitters** (§2).
- **The BUILD-3 shipped constants** `K_SPREAD_PIT` / `PIT_SPREAD_HR` and the hit-tail λs (§1, §2).
- **`insample-frame-check`**, the only tool cited from shipped source (§4.3).
- **`tournament-matchupk.ts`, `pithr-form-bakeoff.ts`, `diag-pithr-2043.ts` — frozen on purpose, not
  drifted by accident.** Each carries an in-file rationale for its non-deployed baseline
  (`forms.ts:803-809` for matchup-K; "exhibit the unconstrained vertex" for the other two). Leave
  them alone.
- **30 tools have no committed artifact and no number-bearing citation** — Tier 4. Nothing rests on
  them.

---

## 6. What "frozen on purpose" vs "drifted by accident" looks like here

| | Frozen on purpose | Drifted by accident |
|---|---|---|
| Marker | an in-file comment naming the non-deployed form and saying why | a label reading `deployed` / `SHIPPED` / `Adopted` with no such note |
| Examples | `tournament-matchupk.ts` (`forms.ts:803-809`), `pithr-form-bakeoff.ts:125`, `diag-pithr-2043.ts:71` | `ceiling-test.ts:89` `"deployed (StuffAug, K=log)"`, `hitter-tails.ts:73` `"PIT deployed(K=log)"`, `family-twoaxis.ts:105` `"deployed stuffaug(K=log)"`, `context-invariance.ts:36` `"the adopted form"` |
| Risk | none — the semantics are published | the *label* is what got transcribed into `docs/`, and the label is now false |

The four Tier-1 tools were all **correct when they ran**. Their defect is not a bad measurement; it
is that they still assert a stale identity, so (a) a re-run silently reports the wrong baseline and
(b) the numbers already copied into `docs/` read as statements about production when they are
statements about a form retired on 2026-07-14.

---

## 7. Findings, in the order they matter

1. **`PINNED_HIT_TAIL` is clean** — the λ fit never calls `fitHitForm`, and `RAWPOLY_HIT` cannot pin
   on any league window. No shipped constant is exposed. *(§1)*
2. **Plan §11.28's `Δ +0.157` is not headroom above production** — re-measured against the deployed
   pareto it is **+0.055 [0.031, 0.081]**, 3.5× smaller. *(§4.1)*
3. **Production already sits at the §11.26 "ceiling ≈ 0.78"** — the shipped pareto measures 0.78–0.79
   in-frame, not the 0.62–0.64 the tools still label "deployed". *(§4.2)*
4. **`context-invariance.ts` mislabels on two axes at once** — it calls an all-quad-BB form "the
   adopted form" (deployed BB is log), and quotes "deployed ~0.62" (StuffAug's, not the pareto's).
   Not re-run; same instrument as 2–3.
5. **The pinning axis is a re-run hazard only** — one channel, one window, 6.28e-4 wOBA. *(§3)*
6. **No committed fixture is exposed. 30 tools cite nothing.** *(§2, §5)*

---

## 8. Structural note (report only — nothing was changed)

The consistency sweep's proposed guard still fits: a directory scan asserting that no file under
`tools/` may name `STUFFAUG_PIT` / `RAWPOLY_PIT` adjacent to the words `deployed` / `shipped` /
`adopted` without an allow-list entry. This audit shows the guard should key on the **label**, not
the fit call — the fits were mostly fine; the labels are what leaked into `docs/`.
