# Cap/Slots Objective Rework — Plan

## Shipped architecture (2026-07-03)

Cap/slots roster generation now runs an **E[wins]-derived MILP objective** (`usageWeights`
in `src/optimizer/roster-lp.ts`): the per-(card, role, slot) coefficients are E[wins]
marginals, the tournament spend dials are wired as **soft segment-spend constraints**, and
the roster page shows a **calibrated win%** (`expectedWin`/`referenceD` in `server.ts`,
anchored so a 0-variant optimum reads .500). The E[wins] evaluator lives in `src/eval/*`
with the assignment sub-solve in `src/optimizer/assign.ts`. The marginal-exchange search
(`roster-search.ts`) described below was explored, then **retired** — the MILP does the
combinatorial allocation directly. Non-cap mode is unchanged. The rest of this doc is the
original planning record, kept for rationale.

---

Status: **proposed** (2026-07-02). Supersedes the "cap/slots weights overhaul" framing.
Reopens the *method* half of **D5** (the weighted-LP cap/slots objective); keeps D5's
starters-first economics and tractability concern, keeps **D2**'s value baseline, leaves
**non-cap mode untouched** (it is done, tested, correct).

## Why we're not just tuning weights

The cap/slots objective maximizes a **weighted linear sum** of per-(card, role, slot)
values under the budget. Investigation found three cross-role double-credits, all on the
hitter side once the pitcher one is fixed (slotted starter paid `slotW·vSP` **and**
`bullpenW·vRP`; lineup starter paid lineup value **and** `benchW·max`; `bothSidesBonus`
×1.25 at threshold 0 = a near-blanket hitter inflator that also re-pays neutrality the
two-lineup structure already rewards). But the deeper finding is that **the weights are
playing-time shares in disguise** (slot decay ≈ IP-by-rotation-slot, `bullpenW` ≈ reliever
IP share, `benchW` ≈ bench PA share, both-sides ≈ PA vs both hands), and that **weighting
exists only to linearize an objective HiGHS can solve** — it is a crutch, not a model.

The object we actually care about — **expected win%** — is a *closed-form function of a
roster* (runs scored from the lineup, runs allowed from the staff, Pythagorean → win%). It
is nonlinear, which is the only reason it isn't the LP objective. So the rework is: **build
the true objective, and optimize it directly with a method that scales in pool size.**

### Why not the obvious alternatives
- **Keep weighted MILP (A):** variable count scales with the ~3000-card **pool** (a
  card×position×side assignment model to pick 26), ~90% wasted on cards that never roster;
  and the weights stay arbitrary.
- **Generate-and-judge (D):** runs the ~5s MILP K times → 100–250s at 3000 cards. Rejected
  on compute.
- **Lagrangian shadow-price (B-exact):** clean for **cap** (one linear budget → scalar λ,
  bisection) but ugly for **slots**, which is ~6 *nested cumulative cardinality quotas*, not
  a budget: needs a coupled multiplier vector (subgradient, not bisection), non-separable
  through the tier nesting, and cardinality constraints leave a duality gap needing primal
  repair. It would force cap and slots onto different machinery.

The method that scales in pool size **and** treats cap/slots uniformly is **marginal /
local-search selection driven by the true E[wins]** — the pool enters only through cheap
`O(N)` marginal scans; the combinatorial work (positional assignment, rotation) stays on the
~26 selected cards as a small exact sub-solve; budget is a cost tracker (cap) or per-tier
counters (slots).

## Phase 1 — the Expected-Wins evaluator (foundation)

A single `roster → E[win%]` function, consuming the one scoring core's per-(card, side)
values. This is the shared foundation for *any* method (B/C/D) and also becomes the one place
H/P balance lives (one currency = runs; the `hitterEmphasis`/`pitcherEmphasis` fudge retires).

**Components**
- **Runs scored** from the 9 lineup slots. Team offensive rate = PA-weighted lineup wOBA,
  blended across vL/vR by opponent-hand exposure (`platoonVR/VL`). Convert wOBA→runs via
  `wRAA = ((wOBA − lgwOBA)/wOBAscale)·PA`, `RS = lgR + wRAA_team`. `wOBAscale`/`lgwOBA` come
  from the existing wOBA-weights (wRAA) module — one source of truth, no new constant.
- **Runs allowed** from rotation + bullpen. Each pitcher's allowed wOBA = `0.320 − value`
  (invert `valueFor`). Team allowed wOBA = IP-weighted (rotation IP by slot + bullpen IP) →
  `RA` via the same conversion.
- **Usage model** (the honest replacement for the magic weights): lineup PA (start simple —
  equal or a standard batting-order PA curve), rotation IP by slot, bullpen IP share. A
  **small, explicit, tournament-scoped table**. This is where "starters ≫ support" now lives,
  transparently.
- **Pythagorean**: `win% = RS^x / (RS^x + RA^x)` (x ≈ 1.83, tune to OOTP). Output E[win%] +
  an `{RS, RA}` breakdown for transparency (also feeds a grid "roster strength" readout).

**Module home:** a new `src/eval/` (roster-level aggregation), consuming — never duplicating
— the scoring core's per-card values. One evaluator, used by the optimizer objective, the
benchmark, and any UI strength display (the one-core principle, at roster grain).

**Validation:** unit tests on the wOBA→runs conversion (known wOBA → known runs); sanity
(all-average roster ≈ .500; elite roster high); and a divergence check — rank a few
hand-built rosters by E[wins] vs the current weighted objective and eyeball where they
disagree (that disagreement is the proxy error we're removing).

## Phase 2 — marginal-exchange selector + the gap benchmark gate

**Selector**
- **Greedy fill:** from required locks, repeatedly add the card with best `ΔE[wins]/Δcost`
  (cap) or best `ΔE[wins]` within remaining tier room (slots), respecting structural
  constraints (positions fillable, roster size, coverage depth, rotation). `O(N)` marginal
  scan per add, incremental (a card only affects its role/position/slot incumbent).
- **Local exchange:** add/drop/swap moves until no improving move on E[wins]. Each candidate
  move re-runs the small **assignment sub-solve** (optimal lineup+rotation assignment of the
  selected ≤26 — exact, `O(1)` in pool size), so *within-set* assignment is never heuristic.
- **Multi-start:** a few seeds (greedy, MILP-seed, perturbed) → keep the best local optimum;
  the spread is a free variance readout.
- **Budget:** cap = running cost ≤ total; slots = per-tier cumulative counters (reject a move
  that breaches any cumulative limit). Uniform across modes — no dual, no repair.

**The gate (measure, don't assume "not always optimal"):** a benchmark harness that, per real
tournament (Bronze Cap, Silver Cap, Gold Slots, …), runs the heuristic **and** an exact
oracle on the **same objective**, over a pre-filtered pool (the existing telescoping filter,
3000 → few hundred) where the oracle is tractable, and reports the E[wins] gap.
- **Oracle construction:** RS and RA are each *linear* in card selection; near .500, win% is
  ~linear in `RS − RA` (run units). So the MILP maximizes `RS − RA` **exactly**; both the
  MILP roster and the heuristic roster are then scored under the **true Pythagorean E[wins]**
  and compared. (Caveat: the linear surrogate degrades far from .500 — noted, acceptable for
  a bound.)
- **Threshold:** if the gap is <~1% across tournaments → ship the heuristic. If some
  tournament shows a fat gap → that tournament falls back to **MILP + pre-filter on the
  `RS − RA` objective** (a principled linear objective — no arbitrary weights — that the
  benchmark would itself have selected).

Expected gap: <1% after local search — assignment is exact per set, real pools are smooth and
high-substitutability (small knapsack granularity), and the heuristic optimizes the *right*
objective while the old MILP was exact on a *wrong* proxy. A sub-1% gap sits inside the
model's own per-card estimation error (false precision to chase further). But the gate
replaces this estimate with a measured number before we commit.

## What changes / what doesn't
- **Reopened:** D5's *weighted* cap/slots objective (its starters-first decomposition +
  tractability concern are honored from the other side: small solves + a cheap faithful
  evaluator, not one monster MILP).
- **Kept:** D2 value baseline (fixed 0.320 signed distance) for this pass. Replacement /
  positional value is the logged *next* decision (touches the scoring core — separate).
- **Untouched:** non-cap mode (`buildRosterLp` `mode:"none"`). The existing MILP builder
  stays — it is the non-cap path, the Phase-2 seed, and the benchmark oracle.
- **Retired (as a consequence, not a patch):** the three double-credits and the H/P emphasis
  knob — structurally impossible under usage-share × value in one currency.

## User-driven allocation control (two tiers)

The rework removes *opaque, duplicated* weights — it does NOT remove user control. Steering
returns as interpretable levers over the ONE objective, which is strictly better than the old
scattered coefficients. Two tiers, both compatible with either optimizer (MILP rows / search
feasibility):

Two levers that are often confused but do different things:

- **Tier 1 — playing-time BELIEFS.** "I disagree with how much a segment *plays*." Adjust what
  E[wins] assumes about usage; it re-values the segment and the optimizer reallocates freely:
  - `rotationDecay` — "value the 5th starter less" (SP5 throws fewer innings),
  - `fullStrengthShare` — how much bench depth is exercised,
  - `platoonCapture ρ` — how often you actually get the favorable matchup,
  - `rotationShare` — the rotation↔bullpen *innings* split (a pitching-usage belief). NOTE: this
    is zero-sum between rotation and pen — it is NOT "spend less on bullpen" (that's Tier 2).
- **Tier 2 — budget PREFERENCES (the answer to "too much on X").** A per-segment budget cap/floor
  (`bullpen ≤ X`, `pitching ≥ Y`, `bench ≤ Z`) or a max platoon-specialist count. The user
  states ONLY the constraint; the E[wins] optimizer reallocates the freed budget across **every**
  other segment — hitters, bench, rotation, pen, or any combination — wherever it maximizes wins.
  The user does **not** name the destination; that is the optimizer's job. This is the crucial
  non-simplistic behavior: "less on bullpen" must be free to become "more on hitters", not forced
  into a paired segment.

Both are the honest successors to the old `benchW`/slot-decay/emphasis knobs — interpretable
form. Tier 2 is what most "this roster over-spends on X" requests actually want, and it depends
on an optimizer that reallocates optimally under an added constraint (the MILP does this natively
by re-solving; the search needs the budget-rebalance move) — so it ties to the optimizer choice.

## Modeling refinements (roster realism)

Surfaced by the benchmark (rosters came out 9–10/13 platoon specialists — implausible):
- **Platoon-deployment realism (`ρ`).** The two-lineup model implicitly assumes *perfect*
  deployment (a specialist always faces its good side), which over-values specialists. `ρ` mixes
  `(1−ρ)` of a card's off-side value into its lineup value, so specialists are valued as
  sometimes stuck with the bad matchup. Curbs over-platooning; under a tight cap all-around bats
  win and free budget for pitching (the user's case). `ρ` doubles as the Tier-1 platoon knob.
- **Position/platoon-aware availability.** Replace the uniform absence model: catchers rest more
  (→ backup-C plays more, so backup-C quality matters more), and a *platooned* position already
  has its "backup" starting the other side (→ less pure depth needed). Backup value should rise
  exactly where a position is un-platooned and rests often.
- **Reliever leverage (future).** Weight bullpen BF by leverage so a stud closer isn't valued
  equal to mop-up.

## Implementation status (built + tested)

All of the below is real code under `src/eval/` and `src/optimizer/`, green under `npm test`
(165 tests) + `npm run typecheck` + `npm run typecheck:web`. **Not yet wired into the
server/UI, and nothing committed.**

**E[wins] evaluator (`src/eval/`) — the true objective:**
- `expected-wins.ts` — `winPctFromRuns(offRAA, defRAA, params)` (runs → Pythagorean win%); the
  usage model (`defaultUsage`, `rotationStarts`); `lineupWraa`; `WinParams`.
- `offense.ts` — `offenseRunsAboveAvg`: availability-weighted team offense (leave-one-starter-out
  re-matching gives bench DEPTH real value).
- `set-eval.ts` — `setExpectedWins` (the ONE entry point: offense + defense), `defenseRunsAboveAvg`
  (rotation + leverage-weighted bullpen), `buildUsage`.

**Assignment sub-solve (`src/optimizer/assign.ts`)** — exact max-weight lineup matching
(Hungarian) per platoon side + rotation split: `bestLineup`, `assignRoster`, `effectiveWoba`.

**Marginal-exchange search (`src/optimizer/roster-search.ts`)** — `searchRoster`: cheapest-feasible
construction + multi-start hill-climb on E[wins]; offense/defense cached across the swap scan;
relative spend dials via natural-baseline → soft-penalty constrained re-solve → repair.

**Tests:** `tests/{expected-wins,assign,roster-search}.test.ts`.

## Usage model (settled — tournament-shaped, not guessed)

The honest replacement for the old magic weights; all feed E[wins], all overridable by Tier-1 knobs:
- **Rotation** — `rotationStarts(bestOf, k)` is a day-by-day simulation of the real rule: every
  game is a day; each day the **highest-slotted fully-rested SP** starts; a series that clinches
  early leaves **rest days** (the unplayed games of the best-of-N) on which everyone rests; the
  rotation **never resets** between series (continuous day count); rest cycle = `k` days. Result:
  a continuous cycle is ~even with a **mild top-lean from rest**, and **SP5 is never zero**.
  Handles **4- and 5-man** (`k = minStarters`). Curves: Bo7 5-man ≈ `[22,22,20,19,16]%`; Bo3
  5-man ≈ `[23,22,22,20,13]%`; totals match E[games/series]. `bestOf` is a NEW per-tournament
  input (default 7).
- **Bullpen** — leverage-weighted: the top 1–2 arms (closer, setup) carry premiums
  (`bullpenLeverage` default `[2.5, 1.5]`), everyone else is flat filler; the best rostered
  reliever gets the closer slot. One good arm is worth real budget (~2.5× a filler), the rest
  interchangeable — a tournament only produces a handful of high-leverage innings.
- **Lineup** — gentle top-of-order PA lean; **availability** (`fullStrengthShare`) values bench
  depth via re-matching around an absent starter; **platoon capture** (`platoonCapture ρ`) tempers
  specialist over-valuation (bleeds off-side value in).

**Tier-1 knobs** (in `WinParams`, override the usage defaults): `rotationShare`, `rotationDecay`,
`bullpenLeverage`, `platoonCapture`, `fullStrengthShare`.

**Relative spend dials** (`SegmentDials`, e.g. `{ bullpen: 0.8 }`): "spend less/more on X" as a
fraction of the segment's NATURAL spend; implemented as a soft penalty so it clamps at the pool
floor instead of going infeasible; the optimizer reallocates the freed budget by E[wins].

## Known gaps / caveats
- **Not wired** into the server/UI: `bestOf` + the Tier-1 knobs + the dials aren't exposed yet.
- **Perf**: a natural solve is ~1s on a moderate pool (after fixing a 2× eval bug + caching the
  offense side); a dialed solve ~2×. Not yet snappy enough to drag a dial on a large pool —
  remaining levers: candidate-list pruning, incremental offense, server-side natural-baseline cache.
- **Pool must be cost-diverse**: "spend less on X" needs cheap cards to move to; a top-by-value
  pool decomposition would strand the dials.
- **MILP-vs-search decision still open**: search seeded from the MILP is E[wins]-competitive; cold
  single-swap search underperforms (needs the MILP seed or a budget-rebalance move).
- **Transient HiGHS-WASM segfault** observed once under heavy search; retry-safe, but watch.
- **Position/platoon-aware availability** (catchers rest more; platooned spots need less depth) is
  designed but not built.

## Sequencing
1. Phase 1 evaluator + tests; validate sanity + divergence. **Checkpoint.**
2. Phase 2 selector (cap first, then slots) + assignment sub-solve.
3. Gap benchmark harness; run across tournaments. **Gate:** heuristic vs MILP+pre-filter.
4. Wire the chosen method behind the existing `/api/roster` path; keep non-cap on the current
   builder. Retire the dead weight knobs only after the gate passes.

## Open questions
- Usage-model source: start with defensible constants (batting-order PA curve, rotation IP
  split) or read from tournament/league usage data if available? (Start simple; refine.)
- Pythagorean exponent for OOTP's run environment (calibrate against known outcomes).
- Pre-filter safety: confirm the telescoping filter never drops a true-optimal card at the
  budgets in play (it gates the oracle's validity too).
