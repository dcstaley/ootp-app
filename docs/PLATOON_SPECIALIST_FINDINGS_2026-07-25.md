# Platoon-Specialist Rosters — Findings

**Date:** 2026-07-25 · **Status:** investigation + write-up only. **No code changed, nothing committed.**
**Scope:** `src/optimizer/roster-lp.ts` (selection objective), `src/optimizer/assign.ts`,
`src/optimizer/generate.ts`, `src/eval/offense.ts`, `src/eval/expected-wins.ts`, and the pool slicing
in `src/server/server.ts`.

**Method.** Three scratch servers on non-default ports (8799 pristine; 8801/8802/8803/8804 running the
*unmodified* repo through a throwaway ESM loader hook that rewrites `roster-lp.ts` **in memory only**).
Ports 8787 / 5173 untouched. All 47 tournaments in `data/tournaments/` generated end-to-end through the
real `/api/roster` path, account `oaxaca` (repeated on `cdmx` as a control).

---

## 0. Headline

1. **The symptom is REAL and it is large.** Rostered hitters are **~2.1× as platoon-split** as the
   top-N of the same pool ranked by platoon-blended value, and the rosters look almost exactly like
   *"take the best N by `max(vR, vL)`"*.
2. **The mechanism is a live inconsistency, not the dual-lineup design.** The app already owns an
   anti-specialist parameter — `platoonCapture` (ρ, default **0.8**), whose docstring literally says
   *"curbing over-valuation of platoon specialists"*. It is applied in the **evaluator**
   (`src/eval/offense.ts:26–31`) and **never** in the **selection MILP** (`roster-lp.ts:116`). The
   optimizer maximises at ρ = 1 and then reports a win% computed at ρ = 0.8.
3. **This is a BUG, on the app's own terms.** Judged by the app's own evaluator with one shared
   anchor, the roster chosen at ρ = 0.8 **beats** the production roster in **13 of 16** cap/slots
   tournaments, mean **+0.56 pp** of expected win%, up to **+1.51 pp**. The objective is picking
   rosters its own scorer rates worse.
4. Two secondary contributors, both real, both smaller: the **bench-depth credit still keys on
   `max(vR, vL)`** for pure bench bats on the cap/slots E[wins] path (the withdrawn attribution was
   half-right — see §5), and, **non-cap only**, the **union-of-per-side-top-X pool slicing** admits
   144 one-side cards for every 28 two-side cards.
5. **`bothSidesBonus` is inert twice over** — it is not applied at all in the cap/slots E[wins] branch,
   and even where it *is* applied its default threshold fires for **3 of 3188** eligible cards (0.1%).
   Forcing it on in the E[wins] branch moved the pooled spread by 0.0002 and the one-side-starter
   share by 0.0 pp.

**Contradiction with the framing, stated plainly:** the report was logged against cap/slots, but the
selection defect is **mode-independent** — non-cap rosters are just as lopsided (0.0313 vs 0.0316).
And the specific instance described ("9 or 10 of 13 hitters") does not reproduce on the only
13-hitter tournament in the registry (`live-bronze`: 6 of 12 starters one-side, mean gap 0.0042 — a
low-spread pool where the defect has nothing to bite on). The *pattern* reproduces everywhere the pool
contains platoon spread; the *specific logged instance* does not, so treat the "13 hitters" and the
"cap/slots" details as unreliable recall, not as evidence about scope.

---

## 1. IS IT REAL — the measurement

**Metric.** For each rostered hitter, its platoon spread `|wobaVR − wobaVL|` (the per-side offense
values the optimizer consumes, reconstructed by the roster endpoint).

**Baselines**, both computed over exactly the pool the optimizer sliced (owned + eligible, union of
top-K by `hitVL` and top-K by `hitVR`, K = `topHitters` for non-cap / `HARD_POOL_CAP` = 1500 for
cap/slots):

| Baseline | Meaning |
|---|---|
| **pool mean gap** | spread of the whole candidate pool the roster is drawn from |
| **top-N by BLEND** | spread of the best N by `platoonVR·vR + platoonVL·vL` — *"if you just took the best N players"* |
| **top-N by BEST SIDE** | spread of the best N by `max(vR, vL)` — the "values every card at its favourable matchup" null |

### 1.1 Pooled (47 tournaments, account `oaxaca`)

| Group | n | roster | pool | top-N blend | top-N best-side | one-side starters |
|---|---|---|---|---|---|---|
| cap/slots | 16 | **0.0316** | 0.0124 | 0.0149 | 0.0329 | 53.7% |
| non-cap | 31 | **0.0313** | 0.0259 | 0.0154 | 0.0332 | 70.8% |
| **ALL** | 47 | **0.0314** | 0.0213 | 0.0153 | 0.0331 | **65.5%** |

Repeat on account `cdmx`: roster 0.0293 vs top-N blend 0.0140 — same 2.1× ratio. Not account-specific.

**Read this table twice.** The roster is **2.1×** the top-N-by-blend baseline and, to three decimals,
**equal to the top-N-by-best-side baseline** (0.0314 vs 0.0331). That equality is the fingerprint: the
selection is behaving as if every card were valued at its favourable matchup, full stop.

The cap/slots row is the sharper one — pool 0.0124 → roster 0.0316 is **2.5×** the pool it is drawn
from. A roster cannot be more lopsided than its pool by accident.

### 1.2 By roster role (all 690 rostered hitters)

| Role | mean gap | n |
|---|---|---|
| both-sides starters | 0.0110 | 212 |
| **one-side starters** | **0.0426** | 402 |
| **bench** | **0.0285** | 76 |

(cap/slots only: 0.0126 / 0.0467 / 0.0336.) Bench bats — cards that never start — are **2.6× more
lopsided than the both-sides starters** and well above the pool. A bench bat has no platoon assignment
at all, so there is no design story under which it should be the most lopsided segment; §5 traces it.

### 1.3 Where the symptom is invisible

The nine `live-*` / `ptcs-live` tournaments show roster gaps of 0.004–0.007 and roster ≈ top-N ≈ pool.
Those pools have almost no platoon spread to exploit, so the defect has nothing to bite on. **The
symptom's visibility scales with the pool's platoon spread**, which is why it reads as intermittent.

---

## 2. THE MECHANISM

### 2.1 The two functions disagree about one number

**The SELECTION objective** — `src/optimizer/roster-lp.ts:112–129`:

```ts
const bothSides = Math.min(c.valueVR, c.valueVL) >= bsThresh ? bonusEff : 1;   // :113
for (const side of ["L", "R"] as const) {
  const w   = side === "R" ? opts.platoonVR : opts.platoonVL;                  // :115
  const val = side === "R" ? c.valueVR      : c.valueVL;                       // :116  ← ρ = 1
  ...
  obj.push(`${f6((eweins ? w * val * uw!.lineupPA
                         : hEmph * bothSides * w * val) * wLineup)} ${y}`);    // :121
}
const benchMax = Math.max(c.valueVR, c.valueVL);                               // :126  ← best side
benchCoef[i] = (eweins ? benchMax * uw!.benchPA : hEmph * benchW * benchMax) * wBench;  // :127
```

A card assigned to the vR lineup is credited `platoonVR × valueVR × lineupPA` and **nothing at all for
its vL value**. Implicit physical claim: *a platoon starter faces its favourable hand in 100% of its
plate appearances.*

**The EVALUATOR** — `src/eval/offense.ts:26–31`, scoring the very same roster:

```ts
const rho = p.platoonCapture;                                    // 0.8 by default
const full = bestLineup(hitters, positions, side, rho);          // :31
```

with (`src/optimizer/assign.ts:66–67`):

```ts
export const effectiveWoba = (c, side, capture = 1) =>
  capture * sideWoba(c, side) + (1 - capture) * sideWoba(c, side === "R" ? "L" : "R");
```

and the parameter's own docstring (`src/eval/expected-wins.ts:32–35`):

> *"Platoon capture rate ρ ∈ (0,1]: how often a fielded card actually gets its favorable matchup.
> ρ<1 bleeds `(1−ρ)` of the off-side value in, **curbing over-valuation of platoon specialists**
> (ρ=1 = perfect deployment)."*

`DEFAULT_WIN_PARAMS.platoonCapture = 0.8` (`expected-wins.ts:53`). The evaluator is otherwise
structurally identical to the objective — per-side lineup value, weighted `platoonVR·R + platoonVL·L`
(`offense.ts:51`) — so **ρ is the only structural difference between what the optimizer maximises and
what the app then scores.**

The same ρ = 1 assumption is repeated on the display path: `generate.ts:28` calls
`bestLineupLocked(rostered, positions, side, 1, locks)` with a comment stating *"Pure side value
(capture = 1)"*, and `generate.ts:105` computes the displayed H/P balance as `Σ max(valueVR, valueVL)`.
`assign.ts:141–142` likewise takes `matchLineup`'s `capture` default of 1.

### 2.2 ρ = 1 is contradicted by the app's own trained exposure artifact

`GET /api/exposure` for the deployed model returns, as *effective* exposure:

| field | meaning | value |
|---|---|---|
| `platoonVR` | team PA share vs RHP | 0.6309 |
| `r_hit_split` | **a RHB's** PA share vs RHP | 0.5811 |
| `l_hit_split` | **a LHB's** PA share vs LHP | 0.2854 |
| `s_hit_split` | a SHB's PA share vs RHP | 0.6142 |

Under realized deployment a **LHB gets its favourable (RHP) matchup 71.5% of the time**, and a **RHB
gets its favourable (LHP) matchup 41.9% of the time** — not 100%. So the app already measures hitter
hand-exposure, already uses it for the display OVR blend (`src/scoring-core/score-card.ts:179–184`
`hitBlend`), and the selection objective is the one place that throws it away. ρ = 0.8 is if anything
*generous*; the artifact implies something in the 0.45–0.75 band.

### 2.3 Counterfactual: apply ρ in the objective, change nothing else

Loader hook substitutes `roster-lp.ts:116` with the `effectiveWoba` blend (and `:126` likewise), i.e.
exactly the transform the evaluator already performs. Control run at ρ = 1 reproduces the pristine
server to the digit (0.0314 / 65.5%), confirming the harness is inert.

| | roster gap (all) | cap/slots | one-side starters |
|---|---|---|---|
| production (ρ = 1) | 0.0314 | 0.0316 | 65.5% |
| **ρ = 0.8 in the objective** | **0.0217** (−31%) | **0.0193** (−39%) | **59.0%** |
| top-N by blend (reference floor) | 0.0153 | 0.0149 | — |

Paired across 47 tournaments: **43 more balanced, 1 more split, 3 unchanged.**

### 2.4 The decisive test — the objective loses to itself

Both rosters re-scored on **one server, one evaluator, one `Dref` anchor** (the ρ = 0.8 roster is
forced onto the pristine server via `locked=<memberIds>`, so `expectedWinPct` is directly comparable):

| tournament | E[win%] production (ρ=1) | E[win%] ρ=0.8 roster | Δ |
|---|---|---|---|
| gold-sporer-sandlot | 0.49992 | 0.51501 | **+1.508 pp** |
| diamond-cap-daily | 0.50741 | 0.52229 | **+1.487 pp** |
| gold-slots | 0.50459 | 0.51569 | +1.110 pp |
| bronze-cap | 0.49847 | 0.50862 | +1.015 pp |
| bronze-cap-weekly | 0.50140 | 0.51031 | +0.890 pp |
| gold-cap | 0.51495 | 0.52251 | +0.756 pp |
| nightmare-cap | 0.50000 | 0.50612 | +0.612 pp |
| silver-cap | 0.51094 | 0.51685 | +0.591 pp |
| silver-slots | 0.51495 | 0.51986 | +0.491 pp |
| ptcs-cap | 0.50094 | 0.50430 | +0.335 pp |
| wonky-slots | 0.50554 | 0.50791 | +0.237 pp |
| silver-deadball-slots | 0.51758 | 0.51981 | +0.224 pp |
| live-slots-weekly | 0.49060 | 0.49060 | 0.000 (identical rosters) |
| ptcs-live | 0.49882 | 0.49881 | −0.002 pp |
| live-time-slots | 0.50015 | 0.49974 | −0.040 pp |
| cwhit-cap | 0.50623 | 0.50370 | −0.253 pp |
| **mean** | | | **+0.560 pp** |

13 wins, 1 material loss (`cwhit-cap`, −0.25 pp — MILP tie-breaking on a low-spread pool), 2 ties.
Every roster respects the same budget (cost column identical to the cap in every case).

This is the whole argument in one table: **a strictly-better-scoring roster exists under the app's own
metric, and the production objective is not finding it because it optimises a different function.**

### 2.5 Worked case — `gold-cap`

Production roster (ρ = 1) vs the ρ = 0.8 roster, membership diff, both at cost exactly 1580:

```
-- only in the PRODUCTION (rho=1) roster --
Vaughan     ★ HOF 1 - Veteran Presence LF Arky Vaughan BRO 1947
            bats=L cost=75  vR=0.3302 vL=0.1798  gap=0.1504  blend=0.2747  role=vR
Sosa        June Gems - Baseball Reference 3 RF Sammy Sosa
            bats=R cost=43  vR=0.1972 vL=0.2766  gap=0.0794  blend=0.2265  role=bench
Brief       Happy Easter 2X Variant Booster 1B Bunny Brief
            bats=R cost=40  vR=0.1296 vL=0.2579  gap=0.1283  blend=0.1770  role=bench
Lombard Jr. ★ FLF 13 & Co. - Future Legend SS George Lombard Jr.
            bats=R cost=86  vR=0.3143 vL=0.3213  gap=0.0070  blend=0.3169  role=both

-- only in the capture-consistent (rho=0.8) roster --
Quintero    FLF 14 & Co. - Future Legend CF Eduardo Quintero
            bats=R cost=88  vR=0.3217 vL=0.3218  gap=0.0001  blend=0.3217  role=both
Lugo        July Jewels - Baseball Reference 4 SS Julio Lugo
            bats=R cost=73  vR=0.3125 vL=0.3064  gap=0.0061  blend=0.3102  role=both
Everitt     ★ Unsung Heroes 1B Bill Everitt CHC 1898 v5
            bats=L cost=42  vR=0.2661 vL=0.2573  gap=0.0088  blend=0.2629  role=bench
Gremminger  ★ Rookie Sensation 3B Ed Gremminger BSN 1902
            bats=R cost=41  vR=0.2536 vL=0.2435  gap=0.0101  blend=0.2499  role=bench
```

**Arky Vaughan** is the textbook case. His card is genuinely that lopsided — verified against the raw
ratings (`/api/debug/card`): vs L he carries **Power 4, Gap 4, Avoid K 24**, producing 244 SO and
**zero HR and zero XBH per 600**. His vL offense is 0.1798, i.e. **0.140 below the anchor**.

- Production objective values him at `0.6309 × 0.3302 × lineupPA` and never looks at the 0.1798.
- His platoon-blended value is **0.2747** — *worse than a 73-cost Julio Lugo at 0.3102, and worse than
  every one of the eight both-sides starters already rostered.*
- Swapping Vaughan + Sosa + Brief for Lugo + Everitt + Gremminger (Lombard Jr. → Quintero absorbs the
  cost) is **+0.756 pp of expected win%** under the evaluator.

The balanced hitter genuinely should win here, and does not. Solver-run, not argued from the objective
string.

---

## 3. BUG OR DESIGN

**Bug.** Not a close call, and the reasoning does not depend on my judgement about how OOTP tournaments
actually play:

- The parameter that fixes it (`platoonCapture`) **already exists**, is **already defaulted to 0.8**,
  is **already exposed as a Tier-1 tournament knob** (`t.tuning.platoonCapture`, `server.ts:938`), and
  its docstring **already names this exact failure mode**. Nobody has to decide anything new.
- It is applied in the evaluator and not in the objective. That is a two-function inconsistency, and
  §2.4 shows the objective loses to itself under the app's own metric by up to 1.5 pp.
- The user-facing `expectedWinPct` is computed at ρ = 0.8, so the number shown next to the roster is
  *already* discounting the specialists the roster was built to collect.

**What is NOT a bug** (design, correctly working, leave alone):

- The **dual-lineup structure** (hypothesis 2). Even at ρ = 0.8 the roster gap (0.0217) sits above the
  top-N-by-blend floor (0.0153). That residual is genuine platoon-pairing value: with 13–18 hitters
  covering 16–18 lineup slots, pairing a vR bat with a vL bat *is* better than two average bats, and
  the optimizer is right to do some of it. The defect is the *magnitude*, not the existence.
- **D5 economics** (starters ≫ bench, per-role support budgets). Untouched by everything here.

**The residual design question worth surfacing** (not a fix): what *is* the right ρ? 0.8 is a guess.
§2.2 shows the trained artifact implies 0.42 (RHB) to 0.72 (LHB), hand-dependent, and OOTP's actual
substitution rules (lineup set at game start by the opposing starter's hand; relievers of both hands
arrive later; limited in-game subs) argue for the lower end. **This is a decision for the user, and it
is a separate decision from "apply ρ at all".**

---

## 4. `bothSidesBonus` — inert twice over (hypothesis 3, closed)

Defaults (`roster-lp.ts:44–45`): `bonus = 1.25`, `bothSidesThreshold = 0`.

1. **Not applied on the production cap/slots path.** `roster-lp.ts:121` multiplies by `bothSides` only
   in the `else` (legacy / non-cap) leg of the ternary; the `eweins` leg — the only one cap/slots
   generation ever takes — omits it entirely.
2. **Inert even where applied.** The threshold is on the *signed-distance* scale, so `min(vR, vL) ≥ 0`
   means *both* sides at or above the elite anchor `TARGET_WOBA = 0.320`. On `gold-cap` that is
   **3 of 3188** owned eligible cards (0.1%). Non-cap tournaments run the same threshold, so the bonus
   is decorative there too.

**Measured:** forcing `bothSides` into the `eweins` leg (loader hook, `BSB=1`) moved the pooled roster
gap from 0.0314 → **0.0312** and the one-side-starter share not at all (65.5% → 65.5%). It is not a
lever; do not reach for it as the fix.

*(Sign note for whoever touches it later: it is a **multiplier on a signed value**. If the threshold
were lowered below 0 it would start multiplying **negative** values by 1.25 — i.e. penalising exactly
the balanced cards it is meant to reward. It is only safe as written because the threshold is so high
that nothing negative ever qualifies.)*

---

## 5. Secondary contributor A — the bench credit still keys on `max(vR, vL)`

The withdrawn attribution said the bench-depth credit on `max(vR, vL)` cannot have caused this because
the E[wins] branch nets it. **That is true for STARTERS only.** `roster-lp.ts:149–160` subtracts
`benchCoef[i]` via the `zst_i` start-indicator when a card starts a side. A card that never starts —
a *pure bench bat* — keeps the full `max(vR, vL) × benchPA` credit. So on the production cap/slots
path a bench bat is still priced at its **better side**, and §1.2 shows the consequence: bench gap
0.0336 vs both-sides-starter gap 0.0126.

`benchPA` = `(1 − fullStrengthShare) × avgPA × 0.3` = `0.4 × 689 × 0.3` ≈ **82.7 PA**
(`server.ts:955`). For Bunny Brief that is `(0.2579 − 0.1770) × 82.7` ≈ **6.7 wOBA·PA of pure
overcredit — about a third of the entire value of a bench slot** (`0.25 × 82.7 ≈ 20.7`). That is why
`gold-cap`'s bench came out as Sosa (0.079), Spohrer (0.053), Brief (0.128), Scott (0.008).

**Isolated counterfactual** (ρ applied to the bench term only, lineup left at ρ = 1):

| | bench gap | one-side-starter gap | roster gap (pooled) |
|---|---|---|---|
| production | 0.0285 (cap/slots 0.0336) | 0.0426 | 0.0314 |
| bench term blended | **0.0131** (cap/slots 0.0148) | 0.0429 (unchanged) | 0.0298 |

Clean isolation: it fixes the bench and touches nothing else. **E[win%] impact is ≈ 0** (mean +0.00 pp
over the 16 cap/slots tournaments), because the evaluator prices bench depth through a leave-one-out
re-match rather than through this linear term. So this is a **visible-symptom and internal-consistency
defect, not a strength defect** — it changes who sits on your bench, not how often you win. It is,
however, a large share of what a user *sees* when they scan the roster page and count specialists.

---

## 6. Secondary contributor B — union-of-per-side-top-X pool slicing (NON-CAP ONLY)

`server.ts:740–743`:

```ts
const unionTopHit = (k) => new Set([...byVL.slice(0, k), ...byVR.slice(0, k)].map((e) => e.dispId));
const hitterPool  = unionTopHit(poolH);   // poolH = topHitters (100) for non-cap; 1500 for cap/slots
```

A card enters the pool if it ranks top-K on **either** side. A balanced card ranked 101st on both sides
is excluded; a specialist ranked 90th vs R and 800th vs L is admitted.

Measured on `bronze-quick` (non-cap, K = 100): union pool = **172** cards, of which **28** make both
lists (mean gap 0.0093) and **144** make only one (mean gap **0.0351**). Ranking the same owned pool by
platoon-blended value and taking the top 172, **47 of them are missing from the optimizer's pool — the
highest-ranked exclusion sits at blend-rank 65** — and those excluded cards average a gap of 0.0065,
i.e. they are the most balanced cards in the pool. Same pattern on `ptcs-bronze` (34 excluded, best at
rank 92), `silver-spectacular` (58, rank 83), `late-bronze` (51, rank 81).

This does not *force* specialists (the optimizer still picks the best of what it has) but it means the
"balanced" archetype is only ~28 deep while the "specialist" archetype is 144 deep. It fully explains
why non-cap one-side-starter shares (70.8%) run *higher* than cap/slots (53.7%) despite the same
objective defect. **Cap/slots is unaffected** — `poolH = 1500` makes the union ≈ the whole owned pool.

---

## 7. Hypotheses checked and closed

| # | Hypothesis | Verdict |
|---|---|---|
| 1 | Is it real? | **YES** — §1. 2.1× the top-N-by-blend baseline; 2.5× the pool in cap/slots. |
| 2 | Dual-lineup structure is the cause | **PARTLY, and legitimately.** Residual 0.0217 vs floor 0.0153 at correct ρ is genuine platoon-pairing value. Not the defect. |
| 3 | `bothSidesBonus` mis-applied | **Confirmed inert, but a red herring** — §4. Measured effect 0.0002. Not the lever. |
| 4 | E[wins] usage weights over-credit the strong side | **YES — this is it**, but the defect is the *missing ρ* in the per-side term (§2), not the PA magnitudes. `lineupPA`/`benchPA`/`buildUsage`/`winParamsFor` are internally consistent. |
| 5 | Platoon-exposure assumption inflates specialists | **YES — same defect, stated from the data side** (§2.2). The objective assumes 100% favourable-matchup capture; the trained artifact says 42–72%. |
| 6 | Scoring side (per-side value itself is wrong) | **NO.** Vaughan's 0.150 gap traces to genuine card ratings (Power 4 / Gap 4 / Avoid K 24 vs L → 0 HR, 0 XBH per 600). Signed pool means are domain-correct (LHB +0.0180 better vs R, RHB −0.0006, mean \|gap\| 0.0083 RHB vs 0.0190 LHB). *One minor note:* the pool transform slightly **widens** Vaughan's gap (pre 0.1353 → post 0.1474, +9%). Single observation; flagged, not pursued. |

**Out of scope, as instructed:** the legacy weights pricing bench depth ~2× toward hitters vs the usage
model's 0.32×. Not chased. Relevant only in that §5's `benchPA` ≈ 82.7 sets the magnitude of the bench
overcredit.

---

## 8. OPTIONS

### Option 1 — apply `platoonCapture` in the selection objective **[BUG-FIX] — RECOMMENDED**

Replace `roster-lp.ts:116`'s raw per-side value with the `effectiveWoba` blend already exported from
`assign.ts:66`, i.e. `val = ρ·v_side + (1−ρ)·v_offside`, threading ρ in via `RosterOptimizeOptions`
from `winParamsFor(t).platoonCapture` (the plumbing for this already exists — `ewinsInputs` builds
`usageWeights` from the same `WinParams`).

- **Pro:** makes the objective agree with the evaluator; **+0.56 pp mean expected win%**, up to +1.51,
  by the app's own metric; uses an existing, documented, user-tunable parameter; one line of real
  change; the ρ = 1 control reproduces today's behaviour exactly, so it is trivially gated.
- **Con:** ρ = 0.8 is a guess (see Option 4). Rosters will visibly change on ~43 of 47 tournaments.
- **Note:** non-cap has no `WinParams` today. Either thread a default ρ there too (recommended — the
  defect is mode-independent) or accept that non-cap stays at ρ = 1 and document it.

### Option 2 — blend the bench-depth credit instead of `max(vR, vL)` **[BUG-FIX] — recommended, independently**

`roster-lp.ts:126`: `benchMax` → the platoon-blended (or ρ-blended) value.

- **Pro:** fixes the most *visible* part of the symptom (bench gap 0.0336 → 0.0148); removes an
  inconsistency where a card that never starts is priced at a side it may never see; independent of
  Option 1 and much lower-risk.
- **Con:** **no measured win% benefit** (≈ 0.00 pp) — the evaluator does not price bench depth this
  way. Purely a correctness/appearance fix. Some tournaments moved ±0.2 pp on MILP tie-breaking noise.
- **Note:** a pure bench bat is a *substitute*, so arguably its correct weight is the platoon blend,
  not ρ-capture. Either is defensible; both are far better than `max`.

### Option 3 — rank the non-cap hitter pool by blend, not per-side union **[BUG-FIX or DESIGN, borderline]**

`server.ts:743`: slice the non-cap hitter pool by blended value (or take the union *and* the top-K by
blend, which only grows the pool).

- **Pro:** stops excluding balanced cards at blend-rank 65 while admitting one-side cards at 144:28.
- **Con:** a pure per-side union is *defensible* for a dual-lineup optimizer — you do want the best vL
  bat even if it is mediocre vs R. Taking the **union of all three** rankings (top-K by vL, by vR, by
  blend) is strictly safe and costs only pool size; a straight swap to blend-only would be a design
  change with a real downside.
- **Recommendation:** the additive form (union of three) only.

### Option 4 — re-estimate ρ from the trained exposure artifact **[DESIGN-CHANGE]**

Derive ρ per batter hand from `r_hit_split` / `l_hit_split` / `s_hit_split` instead of the flat 0.8,
so a LHB is modelled at ~0.72 capture and a RHB at ~0.42.

- **Pro:** replaces a guessed constant with a measured one; the app already computes these per
  tournament (`exposureFor`) and already uses them for the display OVR blend.
- **Con:** the league splits mix deployment choice with in-game hand changes, so they are a *lower*
  bound on what a deliberately-platooned card would capture; a hand-dependent ρ makes the objective
  handedness-asymmetric, which needs its own justification. This is a modelling decision, not a fix.
- **Sequencing:** do Option 1 first with the existing 0.8. ρ is a scalar knob; re-tuning it later is
  free and does not touch structure.

### Option 5 — do nothing, treat specialist-heavy rosters as correct **[DESIGN]**

Defensible *only* if OOTP tournament play really does deliver near-perfect platoon capture (full
lineup swap by opposing starter's hand, negligible reliever-hand exposure, no fatigue/injury
re-matching). If the user believes that, then ρ should be set to **1 in the evaluator** to match the
objective — the current state, where the two disagree, is not an option anyone should choose.

### Not recommended

- **Raising `bothSidesBonus` / lowering `bothSidesThreshold`.** §4: the bonus is not applied on the
  cap/slots path at all, is inert where it is, and lowering the threshold below 0 makes it *penalise*
  balanced cards (multiplier on a signed value). Fixing ρ is the principled lever; this is a patch on
  a patch and cuts against "express logic in the right single place".
- **Post-filtering the roster for balance.** Would break the budget optimality that the MILP exists to
  provide.

---

## 9. Reproduction

Scratch harness (throwaway, in `…/scratchpad/`, nothing written into the repo):

- `rho-hook.mjs` + `register.mjs` — ESM `load` hook rewriting `roster-lp.ts` source in memory
  (`RHO` / `RHO_LINEUP` / `RHO_BENCH` / `BSB` env). Throws if the substitution target has drifted.
- `measure.mjs` — per-tournament roster vs pool / top-N-by-blend / top-N-by-best-side spread.
- `byrole.mjs` — spread split by roster role (both / one-side / bench).
- `common-eval.mjs` — the §2.4 common-evaluator comparison (forces roster B onto server A via
  `locked=<memberIds>` so `Dref` and the evaluator are shared).
- `worked.mjs` — the §2.5 membership diff.

Servers: `PORT=8799 node src/server/server.ts` (pristine); `RHO=0.8 PORT=8802 node --import
file:///…/register.mjs src/server/server.ts` (counterfactual). Control: `RHO=1 PORT=8801` reproduces
8799 exactly.
