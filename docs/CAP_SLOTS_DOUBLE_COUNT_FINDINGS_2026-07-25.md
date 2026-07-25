# Cap/Slots Objective Double-Count — Findings

**Date:** 2026-07-25 · **Status:** investigation + write-up only. No code changed, nothing committed.
**Scope:** `src/optimizer/roster-lp.ts` objective; its production callers in `src/server/server.ts`.

---

## 0. Headline — the bug report is materially wrong about *where* the defect lives

The report says: cap/slots double-counts (SP relief credit + hitter bench credit); non-cap was fixed by
`b35c389`. Three corrections, all verified by running the code:

| Claim in the report | Finding |
|---|---|
| Cap/slots double-counts a slotted SP (`bullpenW·vRP` + `slotW·vSP`) | **Not in the production roster-generation path.** That path always supplies `usageWeights`, which selects the `eweins` branch — and that branch *explicitly nets the relief credit out of the rotation coefficient* (`roster-lp.ts:194`). The double-count survives only in the **legacy weighted branch** (`weighted && !uw`). |
| Cap/slots double-counts a lineup starter (`benchW·max` + lineup value) | **Same.** The `eweins` branch adds a start-indicator `zst_i` with a `−benchPA·max` coefficient (`roster-lp.ts:138–148`) that cancels the bench credit for any card that starts. Legacy branch only. |
| Non-cap was already fixed — "values each card once by its deployed role" | **Only the pitcher half was fixed.** `b35c389` touched the pitcher terms and nothing else (diff confirmed). **The hitter bench double-count is fully live in non-cap mode today**, and by the numbers below it is the *larger* of the two defects. |

And one path the report does not mention, which *is* a live production entry into the buggy legacy
branch:

> **`refineUpgrades` (`server.ts:1275–1349`, the "Biggest Upgrades" stage-2 exact refinement, served at
> `GET /api/upgrades/refine`) builds `opts` from `rosterOptions(t)` and never adds `usageWeights`
> (`server.ts:1292`).** For a cap or slots tournament every one of its re-solves therefore runs the
> **legacy weighted objective with both double-counts live**, while the roster it is measuring against
> was generated under the E[wins] objective. Two different objectives, one comparison.

Net: the reported cap/slots defect is real but **confined to a secondary path**; the *unreported*
defect (non-cap hitters) is live on the primary path; and the *unreported* cross-objective
inconsistency in `refineUpgrades` is arguably the most consequential of the three.

---

## 1. Exact mechanics

### 1.1 The three branches

`buildRosterLp` has three objective regimes, selected by two flags (`roster-lp.ts:57`, `:74`):

```ts
const weighted = opts.mode !== "none";     // roster-lp.ts:57
const uw = opts.usageWeights;              // roster-lp.ts:73
const eweins = weighted && !!uw;           // roster-lp.ts:74
```

| Regime | Condition | Reached from |
|---|---|---|
| **non-cap** | `mode === "none"` | `server.ts:993` (generation, non-cap tournaments) |
| **legacy weighted** | cap/slots **without** `usageWeights` | `server.ts:1310`, `server.ts:1337` (**`refineUpgrades`**); `tests/optimizer.test.ts`; `tests/noncap-objective.test.ts` |
| **E[wins]** (`eweins`) | cap/slots **with** `usageWeights` | `server.ts:1009` (generation) and `server.ts:956` (`referenceD`) |

Defaults when the legacy branch is taken (none of these are set by `rosterOptions`, so these are the
live values): `benchW = 0.3` (`:39`), `bullpenW = 0.15` (`:40`), `rotW = [1, .95, .9, .8, .75]`
(`:19`), `bothSidesBonus = 1.25` with `bothSidesThreshold = 0` (`:44–45`), `hEmph = pEmph = 1`.

### 1.2 Pitchers — term by term

Every rostered pitcher gets a membership term (`roster-lp.ts:174–176`):

```ts
const relief = bullpenW * vRP(c); // legacy relief credit (both modes)      // :174
obj.push(`${f6((eweins ? vRP(c) * fillerBF : pEmph * relief) * wBullpen)} rp_${j}`);  // :176
```

Each rotation-slot variable then gets (`roster-lp.ts:194`):

```ts
const coef = eweins ? (v * rotBF(k) * wRotation - vRP(c) * fillerBF * wBullpen)
                    : (weighted ? slotW(k) * v * wRotation : v - relief);
```

Net credit for a pitcher **deployed as a starter in slot k** (`rp_j = 1` and `xp_j_sk = 1`):

| Regime | `rp_j` + `xp_j_sk` | Verdict |
|---|---|---|
| non-cap | `relief + (v − relief)` = **`vSP`** | valued once ✔ |
| legacy weighted | `bullpenW·vRP·wBullpen + slotW(k)·vSP·wRotation` | **DOUBLE-COUNTED** ✘ |
| E[wins] | `vRP·fillerBF·wBullpen + (vSP·rotBF(k)·wRotation − vRP·fillerBF·wBullpen)` = **`vSP·rotBF(k)·wRotation`** | valued once ✔ |

The `eweins` netting is exact, not approximate: it subtracts *the same* `vRP·fillerBF·wBullpen`
expression that `rp_j` adds. And a slotted starter cannot also hold a leverage (closer/setup) slot —
`lever_j` (`roster-lp.ts:218`) sums the leverage vars **and** the rotation vars against `rp_j`, so the
netting cannot be gamed by parking a starter in the closer slot.

### 1.3 Hitters — term by term

Lineup-assignment terms, one per (card, position, side) (`roster-lp.ts:113`):

```ts
obj.push(`${f6((eweins ? w * val * uw!.lineupPA : hEmph * bothSides * w * val) * wLineup)} ${y}`);
```

Membership term, one per rostered hitter, **unconditional on mode** (`roster-lp.ts:118–119`):

```ts
const benchMax = Math.max(c.valueVR, c.valueVL);
obj.push(`${f6((eweins ? benchMax * uw!.benchPA : hEmph * benchW * benchMax) * wBench)} rh_${i}`);
```

Start-indicator netting, **`eweins` only** (`roster-lp.ts:138–148`):

```ts
if (eweins) hitters.forEach((c, i) => {
  const z = `zst_${i}`; ...
  obj.push(`${f6(-Math.max(c.valueVR, c.valueVL) * uw!.benchPA * wBench)} ${z}`);   // :142
  cons.push(` znet_${i}: ${allY.join(" + ")} - 2 ${z} <= 0`);                        // :146
  cons.push(` zub_${i}: ${z} - ${allY.join(" - ")} <= 0`);                           // :147
});
```

Net credit for a hitter **deployed as a lineup starter**:

| Regime | `rh_i` + Σ`yh` + `zst_i` | Verdict |
|---|---|---|
| non-cap | `benchW·max` + platoon-weighted lineup value | **DOUBLE-COUNTED** ✘ |
| legacy weighted | `benchW·max` + `1.25 ×` platoon-weighted lineup value | **DOUBLE-COUNTED** ✘ |
| E[wins] | `benchPA·max` + lineup value·`lineupPA` − `benchPA·max` = lineup value only | valued once ✔ |

`znet_i` forces `z = 1` whenever the card starts *either* side (`Σy ≤ 2`, so `Σy − 2z ≤ 0` with
`Σy = 1` already pins `z ≥ 0.5` ⇒ `z = 1` on a binary), so one-side platoon starters are netted too.

### 1.4 What is INTENTIONAL and must not be "fixed"

D5 (`docs/REBUILD_REQUIREMENTS_AND_DECISIONS.md:131–160`, plus its superseding note) is explicit that
cap/slots **deliberately** values starters far above support roles and runs per-role support budgets.
None of the following is a defect:

- **Rotation slot decay** (`slotW`, legacy) / **format-derived `rotationBF`** (E[wins]). SP1 being worth
  more than SP5 is the economics, correctly expressed.
- **A genuine bench bat / filler reliever carrying membership value.** A card that never starts *should*
  be worth `benchW·max` / `bullpenW·vRP`. That is depth, not a double-count.
- **Segment dials** `wLineup/wBench/wRotation/wBullpen` (`roster-lp.ts:63`) — preference multipliers, one
  per segment, applied to distinct terms.
- **Two-way cards drawing both a hitter and a pitcher credit** — they play both roles.

The defect is *narrow and precise*: **a card that is deployed as a starter also collects the
support-role credit for the role it is simultaneously not filling.** Everything else is by design.

### 1.5 Two further legacy-branch defects found in passing (not in the report)

- **`bothSidesBonus` is a ×1.25 discontinuity at exactly `min(vR,vL) = 0`** (`roster-lp.ts:105`,
  threshold default 0). Under D2's anchoring, values straddle zero, so this is not the "near-blanket
  inflator" the plan doc feared — measured on the real Gold Cap pool it fires for only **2 of the top 60
  hitters** — but that is worse in kind: a 25% cliff sitting in the middle of the candidate
  distribution, with no continuity on either side. Dead in `eweins` (line 113 ignores `bothSides`).
- **`hitterEmphasis`/`pitcherEmphasis` are inert in `eweins`** but live in legacy — so the
  `pitcherEmphasis` knob silently does nothing on the production cap/slots path (and
  `rosterOptions` never sets it anyway).

---

## 2. Worked examples (executed, not paper)

Both examples below were **run** through `generateFullRoster` (HiGHS in-process) on a synthetic pool
constructed so that exactly one roster spot is contested. Pool: 8 field positions, `dh: false`,
`nHitters: 8` — so *every rostered hitter starts* and there is no legitimate bench role at all. Two
rivals for the single 1B spot, equal cost 75:

```
C_neutral: vR = 0.050  vL = 0.050   platoon blend (0.62/0.38) = 0.05000   0.3·max = 0.01500
D_special: vR = 0.062  vL = 0.030   platoon blend             = 0.04984   0.3·max = 0.01860
```

`C_neutral` is the better lineup card — its platoon-weighted value is higher (0.05000 vs 0.04984).
The bench credit is keyed on `max(vR,vL)`, not the blend, so it pays the *specialist* 0.00360 more.

### 2.1 Hitter analogue — the result, per regime

| Regime | net objective credit, C | net credit, D | **card picked** |
|---|---|---|---|
| value-once (correct) | 0.05000 | 0.04984 | C_neutral |
| **non-cap (`mode:"none"`)** | 0.065000 | **0.068440** | **D_special** ✘ |
| **legacy cap (the `refineUpgrades` path)** | 0.077500 | **0.080900** | **D_special** ✘ |
| E[wins] cap (generation path) | 38.750000 | 38.626000 | C_neutral ✔ |

Arithmetic, non-cap: C = `0.62·0.050 + 0.38·0.050` (=0.05000) `+ 0.3·0.050` (=0.01500) = **0.065000**;
D = `0.62·0.062 + 0.38·0.030` (=0.04984) `+ 0.3·0.062` (=0.01860) = **0.068440**. The 0.00360 bench
differential swamps the 0.00016 real gap by 22×.

Legacy cap adds the ×1.25 both-sides bonus to the lineup terms (both cards qualify here, `min ≥ 0`):
C = `1.25·0.05000 + 0.01500` = 0.077500; D = `1.25·0.04984 + 0.01860` = 0.080900. Same flip.

E[wins] coefficients for the same pair show the netting doing its job:
C: `rh = 4.650, yhR = 24.025, yhL = 14.725, zst = −4.650` → 38.750;
D: `rh = 5.766, yhR = 29.791, yhL = 8.835, zst = −5.766` → 38.626. The `zst` term exactly cancels `rh`.

**This is a real, reproducible mis-pick in the mode the bug report describes as fixed.**

### 2.2 Pitcher analogue — the flip window is knife-edge, by construction

Write `d = vRP − vSP`. In the legacy branch, comparing two arms for the *same* slot k:

> B beats A ⟺ `slotW(k)·(vSP_B − vSP_A) + bullpenW·(vRP_B − vRP_A) > 0`
> ⟺ `vSP_A − vSP_B < [bullpenW / (slotW(k) + bullpenW)] · (d_B − d_A)` = `0.1304 · (d_B − d_A)` at k=1.

`d` is small by construction, because `vSP` and `vRP` differ only by the (hand, role) exposure shift in
`pitchVsRWeight`: `d = 0.06·(vL − vR)` for a LHP and `0.03·(vR − vL)` for a RHP under the standard
split `{sp:{r:.47,l:.27}, rp:{r:.5,l:.33}}`. On the real Gold Cap pool the top-40 SP candidates span
`d ∈ [−0.00102, +0.00155]`, so the **widest possible flip window is 0.00033** in value units — and that
is the extreme LHP-vs-RHP pair, not a typical one.

I could not construct a *plausible* two-card flip: at every parameterisation I tried, making `d_B − d_A`
large enough to flip the pick required a platoon shape so extreme that the two arms' `vSP` were no
longer close. **On paper the mechanism is real; at real coefficient values it is a tiebreak, not a
distortion.** Section 3 confirms this empirically.

---

## 3. Size — one defect is systematic, the other is knife-edge

Measured on the **real catalog** (`docs/pt_card_list.csv`) scored through the deployed core, per
tournament eligibility. "Adjacent gap" = the value difference between consecutively-ranked candidates
(the thing a spurious credit has to beat to change a pick).

### 3.1 Hitter bench credit — **systematic**

| | Gold Cap (pool 2961; 1049 H) | Silver Cap (pool 2542; 870 H) |
|---|---|---|
| adjacent lineup-value gap, top-60 | median **0.00025** (p90 0.00137) | median **0.00027** (p90 0.00101) |
| \|Δ bench credit\| between adjacent | median **0.00147** (p90 0.00418) | median **0.00272** (p90 0.00677) |
| ratio (perturbation ÷ gap) | **≈ 6×** | **≈ 10×** |
| adjacent pairs the credit **inverts** | **21 / 59 (36%)** | **27 / 59 (46%)** |
| top-9 (lineup) membership changed | 1 card | 1 card |
| top-14 (roster) membership changed | 0 cards | 1 card |

The perturbation is 6–10× the median gap it must beat, and it flips **more than a third of adjacent
pairs**. This is a systematic distortion of the *ordering*, not a tiebreak. The membership churn at the
cut looks small (0–1 cards) only because the candidate band is highly substitutable — but 1 card in a
9-man lineup is 11% of the lineup, and the churn is *directional*: the credit is keyed on
`max(vR,vL)`, so it **systematically favours platoon specialists over all-around bats** (a specialist's
`max` exceeds its platoon blend by more than a neutral card's does). That is exactly the
over-platooning symptom already logged in `REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md` §"Modeling refinements"
("rosters came out 9–10/13 platoon specialists — implausible").

### 3.2 SP relief credit — **knife-edge**

| | Gold Cap (686 SP-qualified) | Silver Cap |
|---|---|---|
| adjacent `vSP` gap, top-40 | median **0.00023** (p90 0.00108) | median **0.00014** (p90 0.00096) |
| \|Δ relief credit\| between adjacent | median **0.00007** (p90 0.00019) | median **0.00007** (p90 0.00039) |
| ratio | **≈ 0.3×** | **≈ 0.5×** |
| adjacent pairs inverted | **3 / 39 (8%)** | 6 / 39 (15%) |
| top-5 rotation membership changed | **0 cards** | **0 cards** |
| top-12 staff membership changed | **0 cards** | **0 cards** |

The perturbation is *smaller* than the gap it has to beat. It re-orders a handful of adjacent pairs deep
in the list and changes **no** rotation or staff membership on a pure-value ranking. The historical
"Kralic over Hammaker" case that motivated `b35c389` was real, but it was a near-tie — consistent with
an 8–15% adjacent-inversion rate.

**So the bug report has the two defects ranked backwards.** The pitcher relief credit is the headline
and is the small one; the hitter bench credit is described as "the analogous defect" and is ~20× larger
in differential terms.

### 3.3 Cross-segment: the depth trade is mis-priced by ~6×

Under a shared budget, the marginal question is "one more bench bat, or one more filler reliever?"

- **Legacy weights:** bench bat earns `0.3·max`, filler reliever earns `0.15·vRP` → per unit of card
  value, the legacy objective prefers bench depth **2×** over bullpen depth.
- **E[wins] usage (gold-cap shape, Bo7, 5-man, 7-arm pen):** `benchPA = 82.7`, filler `bullpenBF = 262`
  → **0.32×**, i.e. bullpen depth is worth ~3.2× bench depth.

That is a **~6.3× disagreement** about the same trade. Whatever one believes about the usage model, the
legacy weights and the usage model cannot both be right, and `refineUpgrades` is currently using the
legacy one to re-rank acquisitions for a roster built under the other.

For reference, the E[wins] usage weights actually in play on a Gold-Cap-shaped tournament:
`lineupPA(avg) = 688.9`, `benchPA = 82.7`, `rotationBF = [862, 831, 785, 735, 631]`,
`bullpenBF = [654, 393, 262, 262, 262, 262, 262]` (default leverage `[2.5, 1.5]`; gold-cap's own
`tuning.bullpenLeverage = [2, 2]` shifts the top two).

### 3.4 One residual imperfection in the `eweins` netting (opposite sign, small)

`znet_i` sets `z = 1` when a card starts *either* side, and the `zst` coefficient removes the **whole**
bench credit. A card that starts only vR is genuinely a bench bat in the vL games, so it should retain a
partial bench credit. As built, one-side platoon starters are slightly **under**-credited (by up to
`benchPA·max ≈ 83·|v|`). This is the correct sign of error to have (it discourages over-platooning) and
is far smaller than the defect it replaced, but it is not exact. Logged, not urgent.

---

## 4. Options

All four keep **one builder** and branch only the objective, per the architectural decision on record.
None duplicates a constraint.

### Option A — retire the legacy weighted branch; make `usageWeights` mandatory for cap/slots

Have `buildRosterLp` synthesise default `usageWeights` when `mode !== "none"` and none were supplied
(or, more cheaply, fix the one caller: pass `usageWeights` in `refineUpgrades`). Then cap/slots has
exactly one objective — the already-netted E[wins] one.

- **D5 fit: strong.** The usage model *is* the starters-≫-support economics, stated transparently as
  playing time rather than as tuned weights; per-segment control survives as the `segmentWeights` dials.
- **Pros:** fixes the live cap/slots defect at its actual entry point; removes the `refineUpgrades`
  cross-objective inconsistency (today its baseline objective and its re-solve objectives are in
  different units); deletes the `bothSidesBonus` cliff and the dead `hEmph/pEmph` knobs along with the
  branch; strictly reduces the number of scoring/objective code paths, which is the project's one
  principle.
- **Cons:** `refineUpgrades` re-solves get more expensive (the `eweins` branch adds `zst` + leverage
  binaries; ~26 + n_pitchers extra binaries per solve, and it runs one solve per shortlist candidate —
  perf must be measured before shipping). Removes a fallback that a future caller might want. Requires
  re-baselining the three cap assertions in `tests/noncap-objective.test.ts` and retiring the
  `pitcherEmphasis` test in `tests/optimizer.test.ts` (that knob is already inert in production).
- **Does not fix** the non-cap hitter bench double-count.

### Option B — mirror the netting into the legacy and non-cap branches

Make the netting mode-independent rather than `eweins`-only: emit `zst_i` for all modes with coefficient
`−(mode-appropriate bench credit)`, and change the legacy rotation coefficient to
`slotW(k)·vSP·wRotation − bullpenW·vRP·wBullpen`.

- **D5 fit: strong.** Slot decay, `benchW`, `bullpenW` and the per-role budgets all survive untouched;
  only the *overlap* is removed.
- **Pros:** the smallest conceptual change; fixes all three regimes at once, including the live non-cap
  hitter defect; keeps the legacy weighted objective available as a genuine fallback; the netting
  pattern is already proven in the `eweins` branch (same expression, same guard constraints).
- **Cons:** preserves two objectives with two sets of arbitrary constants — the thing
  `REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md` set out to retire; leaves the ×1.25 both-sides cliff and the ~6×
  bench/bullpen mispricing in the legacy branch (netting the overlap does not make `benchW = 0.3` right);
  adds `zst` binaries to every non-cap solve (perf).

### Option C — structural role partition (make the double-count impossible)

Give every card mutually exclusive **role indicators** summing to its membership variable — hitters:
`start_vR` / `start_vL` / `bench`; pitchers: `rot_k` / `closer` / `setup` / `filler` — and set each
coefficient to (role value × role usage × segment dial). "Valued once by role" then holds by
construction in every mode; `mode` only selects which weight table is used.

- **D5 fit: strongest.** Per-role budgets become literally per-role: each role has its own coefficient
  and could carry its own spend constraint without touching the objective's shape.
- **Pros:** the defect class cannot recur; the segment dials become exactly per-role multipliers;
  removes the arithmetic-netting idiom (which is correct but non-obvious and has already been got wrong
  once); makes the "one-side starter keeps a partial bench credit" fix (§3.4) natural rather than a
  special case.
- **Cons:** by far the largest change; re-baselines every cap/slots output; adds a bench indicator per
  hitter and a filler indicator per pitcher (on top of the existing `zst`/leverage binaries) — **solve
  time on 3000-card pools is the open risk** and the plan doc already flags a transient HiGHS-WASM
  segfault under load. Should be prereg'd with a measured before/after, not bundled with a bug fix.

### Option D — caller-only, no LP change

Pass `usageWeights` in `refineUpgrades` (`server.ts:1292`) and stop there.

- **Pros:** one line; removes the only live cap/slots entry into the buggy branch and fixes the
  cross-objective mismatch; zero re-baselining; the legacy branch becomes genuinely unreachable from
  production and can be deleted later at leisure.
- **Cons:** leaves a live landmine in `buildRosterLp` for the next caller; does nothing for the non-cap
  hitter defect, which is the larger measured problem; leaves the tests pinning the buggy legacy
  coefficients in place, so the codebase still asserts the bug is correct behaviour.

---

## 5. Blast radius

**Consumers of the objective**

- `generateFullRoster` (`src/optimizer/generate.ts:76`) → `Roster.objective`, returned by `/api/roster`
  and displayed on the roster page alongside `balance` (`server.ts:1227`).
- `expectedWinPct` (`server.ts:1010`, shown at `web/RosterPage.tsx:560`) is computed by
  `setExpectedWins`, **not** by the LP objective — so it is objective-independent *except* through which
  roster the LP chooses. It is anchored by `referenceD`, whose result is cached process-lifetime in
  `refDCache` (`server.ts:~950`) and is **pool-approximate**. Any objective change silently invalidates
  that cache: a server restart (or a cache clear) is required or the displayed win% is anchored to a
  roster the current objective would no longer pick.
- `baselineCache` / `setBaseline` (`server.ts:~1014`) stores `r.objective` from the E[wins] generation
  solve; `refineUpgrades` reuses it as `baselineObj` and reports it (`server.ts:1349`) next to re-solve
  results computed in **legacy units**. The reported per-candidate `stage2` deltas are computed from
  lineup/staff *values*, not from objectives, so they are not corrupted — but `baselineObj` as displayed
  is already meaningless today, and this is worth fixing whichever option is chosen.
- Biggest Upgrades **stage 1** (`server.ts:1106–1207`) uses `bestLineupValue` assignment marginals, not
  the LP objective — unaffected by any of this.

**Tests that pin current behaviour**

- **`tests/noncap-objective.test.ts` — read this one carefully.** It pins the **already-fixed non-cap
  pitcher path** (`it("non-cap: a slotted starter is valued by vSP alone …")`, line 45) and that
  assertion **must not regress under any option**. But the same file also *asserts the bug as correct*
  in three places that will need deliberate re-baselining:
  - line 49 `"cap: a slotted starter keeps SP slot value PLUS the relief credit (unchanged)"` — pins
    `vSP + relief`. Breaks under A/B/C.
  - line 53 `"both modes: relievers + bench stay valued (uniformly)"` — asserts `coefOf(none, "rh_0")`
    equals the full bench credit for a hitter that *starts*. **This pins the non-cap hitter
    double-count.** Breaks under B/C.
  - lines 64, 72 — cap slot-decay and cap both-sides bonus. Break under A (which retires the legacy
    branch entirely); survive under B.
  - Note also that this file's `coefOf` helper cannot read negative coefficients (it splits on `" + "`,
    and the builder folds `"+ -"` into `"-"` at `roster-lp.ts:357`). It returns `0` or `NaN` for any
    netted term. Any new assertion on a netted coefficient needs a better parser.
- `tests/optimizer.test.ts` "M4 Phase C — cap & slots budgets" (3 cases) and the two-way cases run the
  **legacy** branch. Their assertions are structural (cost ≤ cap, tier limits, roster sizes) and should
  survive an objective change — with one exception: `"pitcher emphasis shifts cap spend toward pitcher
  value (SP-7 knob)"` (line 202) depends on `pEmph` being live, which it is not in the `eweins` branch.
  That test dies under Option A and should be retired with the knob.
- `tests/cap-slots-milp.test.ts` pins the `eweins` path (cap under `usageWeights`, staff/lineup locks,
  two-way, dial monotonicity, and the `zst` netting at line ~199). Unaffected by A and D; must stay
  green under B and C.
- `tests/expected-wins.test.ts`, `tests/assign.test.ts` — evaluator/assignment only, unaffected.

**Not affected:** the scoring core, the model, calibration, era/park. This is purely an objective-layer
change; no card value moves.

---

## 6. Recommendation *(for review — not a decision)*

**Recommended sequence: D → B(hitter half) → A, and treat C as a separately prereg'd follow-up.**

1. **Fix `refineUpgrades` first (Option D).** It is one line, it removes the only live production entry
   into the double-counting branch, and — independently of the double-count — it ends the situation
   where stage-2 upgrade refinement optimises a *different objective* than the roster it is refining.
   That inconsistency is a violation of the project's one principle and is worth fixing on its own
   merits. Measure the re-solve time before/after: the `eweins` branch adds binaries and
   `refineUpgrades` runs one solve per shortlist candidate.

2. **Then fix the non-cap hitter bench double-count (the hitter half of Option B).** This is the largest
   *measured* defect in the report's subject area, it is live on the primary non-cap generation path,
   and it is the one the report believed already fixed. The fix is to emit the existing `zst`
   start-indicator machinery unconditionally rather than under `if (eweins)`, with the mode-appropriate
   bench coefficient. Expect a visible roster change on non-cap tournaments — fewer platoon specialists,
   more all-around bats — and re-baseline `tests/noncap-objective.test.ts` line 53 deliberately, with
   the new expectation written as "a starter is valued by its lineup value alone; a pure bench bat keeps
   the bench credit".

3. **Then retire the legacy weighted branch (Option A)** once nothing reaches it, deleting
   `bothSidesBonus`, `hitterEmphasis`/`pitcherEmphasis` and the `slotW` fallback with it. Re-baseline
   the three cap assertions in `tests/noncap-objective.test.ts` and retire the `pitcherEmphasis` test.

4. **Do not bundle Option C.** The structural role partition is the right end state and would make this
   class of bug impossible, but it re-baselines every cap/slots roster and carries a real solve-time
   risk on 3000-card pools. It deserves its own prereg with a measured perf gate, after the above has
   landed and settled.

**Explicitly *not* recommended:** copying the non-cap "value each card once, flat" objective into
cap/slots. D5's per-role budgets and starters-≫-support weighting are deliberate and correct; the
`eweins` branch already expresses them honestly as playing time. The fix is to remove the *overlap*
between role credits, not to flatten the role economics.

---

### Reproduction notes

Every number in §2 and §3 was produced by running the real modules (`buildRosterLp`,
`generateFullRoster` with the in-process HiGHS solver, `scoreCard`/`calibrate`/`valueFor`,
`buildUsage`) from throwaway scripts against `docs/pt_card_list.csv` and
`data/tournaments/{gold-cap,silver-cap,gold-slots}.json`. The scripts were deleted after use; no
repository file was modified. Line numbers are as of 2026-07-25; `src/server/server.ts` has
uncommitted changes from concurrent work, so its line references may drift by a few lines.
