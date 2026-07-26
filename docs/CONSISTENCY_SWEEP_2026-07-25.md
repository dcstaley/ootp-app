# Consistency sweep — 2026-07-25

**Scope.** A survey for the defect shape that produced today's four highest-value fixes: *two parts
of the app computing the same quantity differently, with no test pinning them together.* Not
modelling errors — consistency errors.

**Method.** Four parallel source sweeps (constants, scoring-math-outside-the-core, production-vs-
evaluation fitting, eligibility/pool construction), then **empirical verification of every finding
that could be verified by running both paths and comparing numbers.** A probe server was run on port
**8899** against a scratch copy of `data/` (ports 8787/5173 untouched; no files in the repo were
changed). Where a finding is asserted from source alone rather than measured, it says so explicitly.

`npm test` was not modified and remains as found.

---

## Ranked findings

| # | Quantity | Copies | Agree? | Consequence | Severity |
|---|---|---|---|---|---|
| 1 | **"Which roster is better"** — cap/slots MILP objective vs `setExpectedWins` | 2 | **NO — measured ranking inversion** | The optimizer returns a roster the app's own E[win%] rates 0.49 pp *worse* than one it could have returned. Both numbers shown on the same page. | **Critical — changes what the user gets** |
| 2 | **Displayed platoon lineup** — `displayLineup` at ρ=1 vs selection/evaluation at ρ=0.8 | 3 | **NO — measured, different starter** | The vR nine shown starts a different catcher from the nine the E[win%] scores and the MILP selected for. | **High — changes what the user sees** |
| 3 | **`balance.hitterValue`** — `Σ max(vR,vL)` vs the ρ-blend the objective uses | 3 | **NO — measured, 2.1× the displayed value** | The roster page "H-value" is not the number the optimizer maximised, and is on a different footing from "P-value" beside it. | **High — displayed number is wrong** |
| 4 | **Consistency-alarm field cohort** — `computeUnifiedFieldStats` direct vs `productionFieldStats` | 2 | **NO — different cohort by construction** | `/api/debug/consistency` measures frame gaps on the pre-C2′ variant-free coordinate production abandoned. Exactly the drift `productionFieldStats` exists to prevent. | **High — latent, diagnostic** |
| 5 | **Deployed-form parity in `tools/`** — `DEPLOYED_FORMS` vs 40+ hand-built forms, most fit UNPINNED | ~40 | **NO — 0 of 144 tool files import `DEPLOYED_FORMS`** | Includes `hit-tail-bakeoff.ts`, whose fit is the provenance of the shipped `PINNED_HIT_TAIL`. | **High — latent, one feeds a shipped constant** |
| 6 | **Debug BIP trace** — `HIT/PIT_BIP_ADJ` unscaled vs `× era_bip_adj` | 2 | **NO — measured, 1.4–2.1 % on Early Gold** | `/api/debug/card` prints a BIP inconsistent with the singles/XBH on the same line. | Medium — diagnostic only |
| 7 | **Hitter/pitcher selection objective** — `roster-lp.ts` vs the dead `lp.ts`/`pitcher-lp.ts` | 2 | **NO — `lp.ts` carries 3 already-fixed defects** | Unreachable from the server, but exported and exercised by tests, so it looks maintained. | Medium — latent trap |
| 8 | **Pitcher OVR blend** — grid `pitchOVR` (role-agnostic) vs roster `wobaSP/wobaRP` (role-aware) | 2 | **NO — measured, ~0.0005–0.001 wOBA, order can flip** | Cards-page ranking of arms differs from the roster page. Defensible by design; undocumented and unpinned. | Medium — displayed |
| 9 | **`benchWeight` default** | 2 | **NO — 0.1 vs 0.3** | Only reaches the dead `lp.ts`; type doc says 0.1, production path uses 0.3. | Low — latent |
| 10 | **"New tournament" defaults** — `web/shared.ts` vs `src/config/seed.ts` | 2 | **NO — `min_starter_stamina` 55 vs 70** | Two homes for the same template; nothing in `one-copy-constants.test.ts` scans `web/`. | Low |
| 11 | **`valueFor` inverse** (`value ↔ wOBA`) | 3 | Yes (algebraically) | No exported inverse, so each consumer wrote one. | Low — latent |
| 12 | **`qualifiesStarter`** | 4 imports + 5 re-implementations | Yes | `server.ts:712` reads the BASE card; safe only because stamina/pitch-type are absent from `VARIANT_RATING_FIELDS`. | Low — latent |
| 13 | **`inValueRange`** | 2 in `src/`, ~28 in `tools/` | Yes (all agree) | Two tools carry a max-only window (`cwhit-triangulate.ts:49`, `hr-reconcile.ts:318`). | Low |
| 14 | Assorted re-declared constants (`topX=100`, `WOBA_SCALE=1.25`, `HBP_PER_PA=0.008`, `PIT_BIP_ADJ=6`, `0.25` XBH share, `bestOf=7`, `26`, `0.62/0.38`, wOBA weights in tools) | 2–7 each | Yes, all | Grouped below; none currently divergent. | Low |

---

## Finding 1 — the selection objective and the evaluator rank rosters in opposite order

**MEASURED. This is the biggest thing in the sweep and it is the same class as `refineUpgrades`.**

**The quantity.** "How good is this roster", in runs.

| Copy | Where |
|---|---|
| Selection: the cap/slots E[wins] MILP objective | `src/optimizer/roster-lp.ts:132` (lineup), `:147` (bench), `:229` (rotation), `:206-212` (bullpen + leverage), with weights from `src/server/server.ts:960` |
| Evaluation: `setExpectedWins` | `src/eval/set-eval.ts:44-52` → `src/eval/offense.ts:20` + `src/eval/set-eval.ts:24-37`, scored via `src/eval/expected-wins.ts:190` |

`roster-lp.ts` documents the objective as *"the card's run contribution in its role — value × playing
time (PA/BF) from the usage model … puts H and P in one run currency."* It is presented as the
E[wins] objective. It is a **linearisation** of it, and the two differ in at least three places:

1. **Batting-order PA curve.** `ewinsInputs` (`server.ts:960`) collapses the per-slot array to a
   single scalar: `usageWeights.lineupPA = avgPA`. The evaluator's `lineupWraa`
   (`expected-wins.ts:190-195`) **sorts the nine wOBAs descending** and pairs them against the
   declining per-slot curve. Measured curve: `783, 759, 736, 712, 689, 665, 642, 618, 595`; the MILP
   prices **every** seat at `688.9`. So the MILP is indifferent to lineup concentration and the
   evaluator is not.
2. **Bench.** MILP: a flat `benchVal × benchPA` proxy (`roster-lp.ts:147`, `benchPA = (1−f0)·avgPA·0.3`).
   Evaluator: leave-one-starter-out re-matching (`offense.ts:33-44`).
3. **Pythagorean nonlinearity.** `winPctFromRuns` (`expected-wins.ts:65`) is nonlinear in runs; the
   MILP is linear.

**Empirical verification.** Same server, same tournament (`live-slots-weekly`, slots mode), one
cached `.500` reference, two nested candidate pools:

```
ownedOnly=true   (pool 1271)   MILP objective = 18.8479   E[win%] = 48.9793%
ownedOnly=false  (pool 1274)   MILP objective = 20.8762   E[win%] = 48.4909%
```

The larger pool is a **strict superset**, so the MILP optimum must be ≥ — and it is. But the roster
it chose from the larger set is scored **0.488 pp worse** by the app's own evaluator. The MILP could
have returned the smaller-pool roster (it is feasible in the larger pool) and its own E[win%] display
would have read higher. Roster diff was two swaps (Buxton→Carroll, Skubal→Cease), same roster shape,
same cost (2069), same two-way set.

Decomposition (measured, at ρ = 0.8, exposure `platoonVR 0.6851`):

| | offense (runs) | defense (runs) | net |
|---|---|---|---|
| owned-pool roster | +42.08 | −21.36 | +20.72 |
| full-pool roster | +52.20 | −38.81 | +13.39 |

The MILP bought +10.1 runs of offense for −17.4 runs of defense and scored it a **gain of 2.03
objective units**. The H/P exchange rate in the objective does not match the evaluator's.

Also measured, as a component check of (1): the evaluator's offense exceeds the MILP-implied offense
by ~5.5 runs on both rosters — the batting-order concentration credit the MILP cannot see.

**Consequence.** Roster choice, and the top-line number on the roster page. Magnitude (0.49 pp) is
the same order as the `platoonCapture` defect fixed today (0.62 pp).

**Cheapest structural fix.** A test that, for a fixed pool, asserts the MILP-optimal roster also
maximises `setExpectedWins` over a small neighbourhood (e.g. all single swaps against the returned
roster) — it fails the moment the objective and the evaluator disagree in direction. The objective
side needs, at minimum, the per-slot PA curve rather than `avgPA`; that requires an ordered lineup
assignment in the MILP (the `yh_i_pos_vS` vars already exist and could carry a slot index).

---

## Finding 2 — the displayed lineup is matched at ρ = 1; everything else uses ρ = 0.8

**MEASURED. This is the third answer the brief flagged as still open.**

**The quantity.** The nine cards that start against a given hand.

| Copy | Where | ρ |
|---|---|---|
| Displayed lineup | `src/optimizer/generate.ts:28` — `bestLineupLocked(rostered, positions, side, 1, locks)` | **hard-coded 1** |
| Selection MILP | `src/optimizer/roster-lp.ts:52` + `:129` via `effectiveValue` | `opts.platoonCapture` (server always passes it, `server.ts:925`) |
| E[wins] evaluator | `src/eval/offense.ts:26,29` via `effectiveWoba` | `p.platoonCapture` = **0.8** (`expected-wins.ts:53`) |
| `assignRoster` display lineups | `src/optimizer/assign.ts:155-156` — `matchLineup` → `bestLineup(..., side)` | **default 1** |

**Empirical verification.** Real roster, `live-slots-weekly`, 14 rostered hitters:

```
side=R  ρ=1.0 (displayed) : C = Adley Rutschman
side=R  ρ=0.8 (scored)    : C = Dillon Dingler
side=R  SAME = false
side=L  SAME = true
```

The app displays Rutschman starting against RHP; the win estimate on the same page, and the
selection that put both catchers on the roster, assume Dingler starts there. A user who fields the
displayed lineup does not get the roster the optimizer priced.

**Consequence.** A displayed lineup slot, and the fidelity of the E[win%] to what the user will
actually deploy. `assign.ts:155-156` has the identical defect on the evaluator's own display path.

**Cheapest structural fix.** `displayLineup` and `matchLineup` take `capture` from `opts`; a test
asserting `generateFullRoster(...).lineupVR` equals `bestLineup(rostered, positions, "R", opts.platoonCapture)`.

---

## Finding 3 — `balance.hitterValue` is `Σ max(vR,vL)`; nothing else in the app is

**MEASURED.**

**The quantity.** Total hitter value on the roster, shown as "H-value" at `web/RosterPage.tsx:561`.

| Copy | Where | Formula |
|---|---|---|
| Display | `src/optimizer/generate.ts:105` and `src/optimizer/assign.ts:178` | `Σ max(valueVR, valueVL)` |
| Objective (lineup) | `roster-lp.ts:129` | `effectiveValue(c, side, ρ)` weighted by `platoonVR/VL` |
| Objective (bench) | `roster-lp.ts:146` | `platoonVR·effectiveValue(c,"R",ρ) + platoonVL·effectiveValue(c,"L",ρ)` |

`roster-lp.ts:137-145` documents at length why the `max` was removed from the bench credit ("pricing
it at its better side credits it a matchup it may never see"). The display kept it.

**Empirical verification**, 14 rostered hitters, `platoonVR 0.62 / 0.38`:

```
displayed  Σ max(vR,vL)        = -0.029500
platoon ρ-blend  ρ=1.0         = -0.062418   (delta 0.032918)
platoon ρ-blend  ρ=0.8         = -0.063431   (delta 0.033931)
```

The displayed number is **2.1× smaller in magnitude** than the objective-consistent one. Worse, the
`pitcherValue` printed beside it (`generate.ts:106`, `assign.ts:181`) *is* a deployment blend
(`blendPitch`). So "H-value vs P-value" — whose stated purpose (`generate.ts:70-72`) is to let
cross-pool balance under signed-distance be watched — compares hitters at their best side against
pitchers at their realistic role mix. It systematically flatters hitters.

**Cheapest structural fix.** One exported `rosterBalance(hitters, pitchers, opts)` in `assign.ts`
using `effectiveValue`, called by both `generate.ts` and `assign.ts`, plus a test asserting the two
producers agree.

---

## Finding 4 — the consistency alarm measures a coordinate production abandoned

**VERIFIED STRUCTURALLY + quantified inputs; the numeric gap itself was not reproduced.**

**The quantity.** The field cohort that frame gaps are measured on.

| Copy | Where | Construction |
|---|---|---|
| Production | `src/scoring-core/pool-stats.ts:106-107` — `productionFieldStats` | `computeUnifiedFieldStats(presenceMixture(cards, 0.30), …, FIELD_N × PRESENCE_M)` |
| Alarm | `src/eval/consistency.ts:155-156`, reached from `src/server/server.ts:2101-2102` | `computeUnifiedFieldStats(cards, …, fieldN)` — **no mixture, no ×m** |

The docstring at `pool-stats.ts:84-95` says this in as many words: *"THIS EXISTS BECAUSE THE TWO
HALVES DRIFTED APART … for a few hours the EVAL instrument measured a different coordinate from the
one production scored on … Every gate would have passed, because the gates were computed with the
same stale instrument."* The second copy survives in `consistency.ts`.

**Measured inputs to the divergence** (live `cdmx` catalog):

```
catalog cards: 3704   canHaveVariant: 2086 (56.3%)
variant rating delta over 18000 (card,field) pairs: mean +4.27, median +3, range +2..+15
production field  = top 1000 of a 74,080-row presence-weighted mixture (30% v5 weight)
computeConsistency = top 50 of the 3,704 BASE rows
```

Since a v5 outranks its own base on every rating, the production cohort is materially v5-weighted and
the alarm's is not. The two `μ` vectors cannot be equal.

**Consequence.** Diagnostic only (`/api/debug/consistency`) — but it is an *alarm*, and it is
watching the wrong coordinate.

Two related sites, both self-documented as intentional and left alone here: `server.ts:1667-1668`
(`trainingMeans` uses bare `FIELD_N`, variant inclusion comes from the obs rows) and
`server.ts:458-459` (hit-tail channel moments, base-only). A third, `server.ts:2071`
(`/api/debug/pool`), filters without `isBaseCard` while its comment claims to be "the population the
transform's field stats are built on"; benign today only because the catalog CSV carries no variant
rows (verified: neither `data/imports/*.csv` nor `docs/pt_card_list.csv` has a `Variant` column).

**Cheapest structural fix.** `computeConsistency` calls `productionFieldStats`; a test asserting the
two field constructions are identical for a fixture pool.

The related `presenceMixture(x, p) … FIELD_N * PRESENCE_M` pairing is hand-written four times in
`server.ts` (`:417, :442, :2205, :2218`) — an invariant currently enforced only by comment.

---

## Finding 5 — the tools carry the deployed-form drift, and one of them feeds a shipped constant

**Production spec** (`src/training/forms.ts:724`): `DEPLOYED_FORMS = { hit: RAWPOLY_HIT, pit: PARETO_PIT, pinned: true }`,
fit at `src/server/server.ts:1595-1596` with `fitExp = 0.75` and a **live pin collector**.
Compliant mirrors: `residuals.ts:85,90`; the `hitFormModel`/`pitFormModel` wrappers (`forms.ts:644-649`,
default `pinned = true`); `web/ModelTrainingPage.tsx:106-107` (guarded by source assertion).

**Zero of the 144 files in `tools/` import `DEPLOYED_FORMS`.** Every refitting tool hard-codes a
form; all but three fit **unpinned** (`fitHitForm(form, obs)` / `fitPitForm(form, obs)` — two args,
so `pins === undefined`). Groups:

- **~13 tools hand-rebuild a pareto-equivalent** off the *retired* `STUFFAUG_PIT`, unpinned, several
  with headers claiming to run "the SHIPPED pareto": `con-overvalue-check.ts:42`,
  `p5-bronze-adjudicator.ts:39`, `p3-pitch-info.ts:38`, `p4-quad-amplification.ts:36`,
  `p1-winner-vs-pareto.ts:38`, `eb-elite-spread.ts:38`, `fade-microstudy.ts:40`,
  `h3-eghitter-decomp.ts:38`, `synthetic-recon.ts:40`, `phase1c-joint-run.ts:47`,
  `phase1c-b3-edgelevels.ts:39-41`, `phase1c-b4-monotone.ts:29-31`, `satbb-bakeoff.ts:42`.
- **~11 tools still treat `STUFFAUG_PIT` as deployed**: `ceiling-test.ts:89`,
  `phase1c-hitter-report.ts:40`, `tournament-matchupk.ts:51`, `tournament-compare.ts:76`,
  `tournament-cv.ts:76`, `tournament-bb.ts:59`, `tournament-train.ts:217`,
  `tournament-bipfix-validate.ts:41`, `env-neutralize-check.ts:53`, `family-twoaxis.ts:102`,
  `hitter-tails.ts:73`.
- **5 tools use `RAWPOLY_PIT`, a form that was never deployed**: `leaguenorm-audit.ts:59`,
  `bbhr-anchor-impact.ts:27`, `window-length.ts:23`, `pool-transfer.ts:73`, `weight-sweep.ts:32`.
- **Correct form, still unpinned**: `insample-frame-check.ts:27` (right pair, header says "the
  deployed forms", one-argument fix), `tournament-exposure-stress.ts:36`, `diag-pithr-2043.ts:52`
  (header at `:3` claims "same as `server.saveTrainedModel`" — now false on the pinning half).
- **The one that feeds a shipped number**: `tools/hit-tail-bakeoff.ts:569, 609, 633` —
  `fitHitForm(RAWPOLY_HIT, …)` unpinned. `src/scoring-core/hit-tail.ts:8` names this tool as the
  evidence for `PINNED_HIT_TAIL` (`hit-tail.ts:74`, the λ = 2.20/1.10/0.30 operating point that
  ships in all tournament scoring).

**Empirically checked — currently inert on the hitter side.** The live artifact records exactly one
pin:

```
data/trained-models/league-42-43.json   vertexPinned = [{"channel":"pit.hr","pinZ":2.652}]
data/trained-models/league-42-43-2-0.json  same
data/trained-models/league-41-42.json   vertexPinned = null
```

`hit.hr`'s vertex is **not** interior on the production window, so production's hitter fit is
currently identical to the unpinned one and `PINNED_HIT_TAIL`'s provenance is not presently
corrupted. **Not verified**: whether the pin fires on the bake-off's own cwhit-tier window, which is
a different dataset. The exposure remains.

**Clean by contrast** (verified): the tools whose outputs *become* shipped constants —
`fit-kspread-pit.ts`, `fit-kspread-c3.ts`, `fit-hrspread-c6.ts`, `fit-pitspread-hrbab.ts`,
`kramp-gap-trace.ts`, `tournament-kslope.ts` — read `trained.eventForm` off the **active artifact**,
so they get the real production fit including pins. The BUILD-3 ramps are unaffected.

**Cheapest structural fix.** Extend the `deployed-forms` source assertion to a directory scan: no
file under `tools/` may name `STUFFAUG_PIT`/`RAWPOLY_PIT`/`PARETO_PIT` while claiming production
parity, and no two-argument `fitHitForm(`/`fitPitForm(` call may exist outside an explicitly
allow-listed set (`pithr-form-bakeoff.ts` and `diag-pithr-2043.ts` are deliberate).

---

## Finding 6 — the debug event trace derives BIP without `era_bip_adj`

**MEASURED.**

| Copy | Where |
|---|---|
| Core | `src/scoring-core/woba.ts:79` (hit), `:117` (pit) — `600 − BB − K − HR − ADJ × derived.era_bip_adj` |
| Debug trace | `src/server/server.ts:2038` (hit), `:2015` (pit) — `ADJ` **unscaled** |

`era_bip_adj` is derived from the era's rate vector (`src/config/coeff-resolve.ts:106-108`), not from
the era record's `bip` field (which is 1 for all 156 eras). Measured across tournament eras in use:

```
era-1919 2.4258   era-1920 2.3977   era-1896 1.7305   era-1929 1.5939   era-1939 1.4377
era-1984 0.7973   era-2019 0.9004   era-2004 1.1521   era-2010 1.0000
```

Measured on **Early Gold** (era-1920), Adley Rutschman, vR:

```
HIT   trace BIP = 504.827   core BIP = 497.838   (+1.40%)
PIT   trace BIP = 408.703   core BIP = 400.317   (+2.09%)
```

The `single` and `XBH` printed on the same trace line came from `hittingComponents`/`pitchingComponents`,
i.e. from the **core** BIP. So the trace is internally inconsistent for every non-2010 era, which is
most of the tournament library.

**Consequence.** `/api/debug/card` only — but it is the tool one reaches for when debugging an era
bug, and it will mislead.

**Cheapest structural fix.** Have `hittingComponents`/`pitchingComponents` return `BIP_fin` so the
trace cannot fork.

---

## Finding 7 — a second, diverged copy of the selection objective (`lp.ts` / `pitcher-lp.ts`)

**VERIFIED by call-graph.** `src/server/server.ts` imports and calls only `generateFullRoster`
(`:36, :984, :1021, :1025, :1336, :1363`). `generateHitterRoster` / `generateRoster` /
`generatePitcherStaff` / `buildHitterLp` / `buildPitcherLp` are **not reachable from the server** —
their only non-test callers are `optimizer/index.ts` re-exports.

`src/optimizer/lp.ts` is a parallel hitter objective that carries three defects `roster-lp.ts`
documents having fixed:

| Defect | `lp.ts` | `roster-lp.ts` |
|---|---|---|
| Platoon capture ρ | absent — raw `valueVR/valueVL` (`lp.ts:37`) | `effectiveValue(c, side, ρ)` (`:129`) |
| Bench credit basis | `benchW × max(vR,vL)` (`lp.ts:48`) | ρ-blend, `max` removed (`:146`) |
| Starter/bench double-count | none | `zst` start-indicator netting (`:158-168`) |
| Coverage depth basis | `c.positions` — starter-qualified (`lp.ts:63`) | `c.coverPositions ?? c.positions` — backup-qualified (`:193`) |
| `benchWeight` default | `0.1` (`lp.ts:25`) | `0.3` (`roster-lp.ts:40`) |

`tests/optimizer.test.ts` exercises this path, which makes it look maintained.

**Cheapest structural fix.** Delete `lp.ts`/`pitcher-lp.ts`/`generateHitterRoster`/`generateRoster`
and their `index.ts:5-6` exports, or route both through `effectiveValue`.

---

## Finding 8 — two pitcher OVR blends ship in the same session

**MEASURED.**

| Copy | Where | Basis |
|---|---|---|
| Cards grid `pitchOVR` | `src/scoring-core/score-card.ts:172-176`, emitted `server.ts:211` | `coeffs.r_pitch_split/l_pitch_split` — the **SP/RP mean** (`server.ts:378-379` ← `exposure.ts:127`) |
| Roster `wobaSP`/`wobaRP` | `src/optimizer/types.ts:83-90` `blendPitch`, emitted `server.ts:716` | (hand, **deployed role**) split |

Measured, same cards, same tournament:

```
card                       gridVL   gridVR   gridOVR  rosterSP rosterRP
Tarik Skubal               0.3082   0.2981   0.3018   0.3014   0.3021
Evan Sisk                  0.3239   0.3376   0.3326   0.3331   0.3322
Bryan Hudson               0.3254   0.3403   0.3349   0.3354   0.3345
Kirby Yates                0.3373   0.3313   0.3349   0.3349   0.3348
```

Yates and Hudson tie on the grid (0.3349) but separate by 0.0003 as relievers. Defensible — the grid
does not know the role — but it means "the OVR" is two numbers, and `score-card.ts:171` does not say so.

---

## Findings 9–14 — lower-consequence, grouped

**9. `benchWeight` default disagrees: `0.1` (`lp.ts:25`) vs `0.3` (`roster-lp.ts:40`)**, with
`types.ts:200` documenting "default 0.1". Reaches only the dead path (Finding 7). `bullpenWeight ?? 0.15`
agrees across `pitcher-lp.ts:22` and `roster-lp.ts:41`.

**10. Two homes for the new-tournament template.** `web/shared.ts:174-189` `TOURNAMENT_DEFAULTS`
(`min_starter_stamina: 55`) vs `src/config/seed.ts:127,141` (`70`). `tools/config-hygiene.ts:37`
audits against 55. `web/RosterPage.tsx:383,493,515` fall back to `?? 70`; verified that the server
always sends `minStarterStamina` in the roster payload (observed `55` in the live response), so the
fallback does not fire in practice. `tests/one-copy-constants.test.ts` scans **`src/` only** — every
`web/` re-declaration is invisible to it.

**11. The `valueFor` inverse is re-derived three times** — `server.ts:1039-1040`, `assign.ts:59`,
`set-eval.ts:33-34`. All algebraically `± baseline`. `set-eval.ts:33` mixes the configurable
`p.lgWoba` with the hard-coded `TARGET_WOBA` in one expression; correct only because
`DEFAULT_WIN_PARAMS.lgWoba === TARGET_WOBA` (`expected-wins.ts:52`). `calibrate.ts` exports no inverse.

**12. `qualifiesStarter` (`types.ts:61`) re-implemented five times** — `server.ts:712, 1190, 1941`,
`RosterPage.tsx:493, 515`. All formula-identical. `server.ts:712` reads the **base** card `c0` rather
than the variant `c`; safe only because `Stamina` and the pitch-type columns are absent from
`VARIANT_RATING_FIELDS` (`variants.ts:11-20`) — a silent coupling.

**13. `inValueRange` exists twice in `src/`** (`config/eligibility.ts:88-93` vs `server.ts:471-474`)
and ~28 times inline in `tools/`. All agree. `server.ts:475` composes its own `isEligible` rather
than calling `buildEligiblePool`, so the grid's "eligible" badge and the pool that was actually
scored are two computations. Two tools carry a **max-only** window — `cwhit-triangulate.ts:49`,
`hr-reconcile.ts:318-320` — the exact defect `src/eval/cwhit/sample.ts:71-75` warns about.

**14. Re-declared constants that currently agree** (grouped; none divergent):
`topX = 100` — 5 sites incl. three copies of the identical ternary in `server.ts:622, 729, 2526`, and
`one-copy-constants.test.ts:58` **explicitly declines to pin it**; `WOBA_SCALE = 1.25` —
`coeff-resolve.ts:46` and `woba.ts:33` (the comment asserts the match rather than importing it);
`HBP_PER_PA = 0.008` — `scorecard.ts:238` canonical, re-declared `audit.ts:36`, `sample.ts:650,655`;
`PIT_BIP_ADJ = 6` — re-declared as `PIT_HBP_PER600` in `audit.ts:22`, one constant after the same
file documents fixing this exact hazard for `BF_PER_9`; the fixed pitcher XBH share `0.25` — five
literals (`woba.ts:134`, `raw-poly.ts:51`, `forms.ts:299`, `sample.ts:319`, `audit.ts:27`), no named
constant exists; `DEFAULT_WIN_PARAMS` values re-declared as web slider defaults
(`TournamentsPage.tsx:610-615`); `bestOf ?? 7` — `server.ts:930`, `set-eval.ts:17`,
`TournamentsPage.tsx:599`; `topN = 26` in training/eval — seven sites, conceptually "roster size" but
unwired from `roster_size: 26`; `0.62/0.38` team exposure — `server.ts:920`, `TournamentsPage.tsx:159`;
the four wOBA weights hard-coded in `tools/leaguenorm-audit.ts:52` and `tools/spike-calibrate.ts:91,103`
(`src/` is clean — every scoring path goes through `wobaWeightsFromCoeffs`).

Also latent: hitter wOBA assemblies in training use `W_BB` for the HBP term while pitcher assemblies
use `W_HBP` (`forms.ts:257` vs `:300`; `bakeoff.ts:29/35` vs `:46/51`) — numerically identical only
because `DEFAULT_WOBA_WEIGHTS.bb === .hbp === 0.704`. The core is consistent (`woba.ts:169` uses
`w.hbp` for both roles).

Also latent: `refineUpgrades`'s reduced-pool selector ranks by `Math.max(b.valueVR, b.valueVL)`
(`server.ts:1285`) while the objective it then re-solves uses the ρ-blend — a `max` survivor that
affects which candidates get evaluated in Biggest Upgrades (pool membership, not the reported gain).

Also latent: `referenceD` (`server.ts:978-990`) caches the `.500` anchor by tournament id but computes
it from the **first request's pool**, which may be owned-scoped — self-documented at `:975-977`.
**Verified inert on this catalog**: warm-cache (owned-pool reference) and cold-cache (full-pool
reference) both returned `E[win%] = 48.4909%` for the same roster, because the account owns 1271 of
1274 eligible cards. The hazard is real on a sparser account.

Also latent: `isBaseCard` (`server.ts:293`) and the display variant flag (`server.ts:202`) omit the
`.trim()` that `variants.ts:40` and `eligibility.ts:24` apply. **Verified harmless today**: neither
`data/imports/cdmx.csv` nor `data/imports/oaxaca.csv` nor `docs/pt_card_list.csv` has a `Variant`
column at all (variants come from the account overlay's `variantCardIds`), so the predicate never
sees a whitespace-padded value.

Also latent: `.includes("#V")` (`server.ts:981-982`) vs the anchored `/#V$/` used everywhere else —
benign only because card ids are numeric.

Also latent: the grid materialises a v5 row for every `variantCardIds` entry **regardless of
`t.variants_allowed`** (`server.ts:495-498`), while generation checks it (`:702`) and *substitutes*
rather than *appends*. On a variants-banned tournament the two views show different populations.
`src/data/account.ts:35-43` is a third copy of the rule, exercised only by tests.

---

## Categories checked and found CLEAN

State these as results, not omissions.

- **The scoring core is genuinely the only place scoring math lives.** No hand-rolled `cp()` /
  park compression, no hand-rolled softcap, and no "value from ratings" exists anywhere outside
  `src/scoring-core/` + `src/config/derived.ts`. `server.ts:2020,2043` touch park factors but
  *import* `cp`/`getParkFactor` — reads, not redos. `PARK_COMPRESSION = 0.26` is declared once
  (`helpers.ts:20-21`); `tools/park-hand-contrast.ts:35` imports it rather than copying.
- **`web/*.tsx` recomputes nothing.** All eight files render server-supplied numbers. No blend, no
  scalar, no threshold, no environment factor computed client-side. (The web-side issues in this
  report are re-declared *defaults*, not recomputed *values*.)
- **`TARGET_WOBA = 0.320` is a genuine single source** — `calibrate.ts:25`, imported by
  `expected-wins.ts`, `set-eval.ts`, `assign.ts`, `server.ts`. No literal `0.320` elsewhere in `src/`.
- **`FIELD_N` / `ANCHOR_N` / `EXPOSURE_N`** are each declared once and pinned by
  `tests/one-copy-constants.test.ts`, including a regex ban on `fieldN ?? <literal>` defaults.
- **`K_SPREAD_PIT` / `PIT_SPREAD_HR`** are the best-guarded constants in the repo: declared once
  (`pool-transform.ts:310, :480`), every consumer reads fields off the object, and
  `assertKSpreadProvenance` (`:351-361`) actively checks `fitN`/`fitP`/`gMax` against the live
  `FIELD_N`/`PRESENCE_P` at load time.
- **Pool construction is role-agnostic everywhere.** Eleven top-N cut sites checked; not one gates
  by role or position. `exposure.ts:66-69` and `calibrate.ts:5-10` document the removal explicitly.
  The only role filters found are deliberate and documented (`server.ts:458` hit-tail hitter pool,
  `server.ts:1941` debug SP-rank endpoint).
- **The MILP rotation and the evaluator rotation agree.** Measured on both rosters: the MILP's
  `xp_j_sk` slot assignment produced exactly the evaluator's "top-`minStarters` by `vSP`" set. The
  bullpen-leverage constraints did not pull a better arm out of the rotation in either case.
- **`owned > 0` is consistent across all eleven test sites** — `account.ts:24,70`,
  `eligibility.ts:94`, `server.ts:505,526,736,1149,1195,1319`, `CardsPage.tsx:172`,
  `RosterPage.tsx:376`. No `>= 1`, no truthiness test anywhere.
- **`includeVariants` defaults to `true` at all six training/eval sites** and all six filter
  expressions are the identical `includeVariants || !o.variant`. Nothing forces `false`.
- **Variant *eligibility*** (`canHaveVariant`, `variants.ts:69-109`) has exactly one implementation
  and only two consumers, neither of which gates a join candidate set.
- **`IP_TO_BF` / `BF_PER_9` / `PRESENCE_P` / `PRESENCE_M`** are each single-declaration; `audit.ts`
  and `scorecard.ts` import or re-export rather than copy.
- **The bullpen display order is not a divergence.** `RosterPage.tsx:689` sorts the bullpen table by
  wOBA ascending, which matches the evaluator's best-first leverage assignment
  (`set-eval.ts:31`). The MILP's explicit closer/setup vars (`xrpc_j`/`xrps_j`) are simply never read
  back into the result and never surfaced — worth a note, not a defect.
- **`src/eval/cwhit/sample.ts` "DEPLOYED" legs are clean** — they call `pitchingComponents` /
  `hittingComponents` / `trustedPitchingSideWoba` and explicitly refuse to reassemble the composite
  (`:338-339`).
- **`src/eval/consistency.ts:72-118`** deliberately applies no env/transform and documents why
  (`:132-136`). That part is correct; only the *field construction* (Finding 4) is not.

---

## Notes on method

- Findings 1, 2, 3, 6, 8 and the "clean" rotation result were verified by **running both paths and
  comparing numbers**, using a probe server on port 8899 against a scratch copy of `data/`.
- Finding 4 was verified structurally and its *inputs* measured; the resulting `μ` gap was not
  reproduced (it needs the server's assembled coeffs, which are not exposed by an endpoint).
- Finding 5's inertness was verified from the live model artifacts; its exposure on the bake-off's
  own data window was not.
- Findings 7, 9–14 are source-level with call-graph confirmation where reachability mattered.
- No repo file was modified. Probe scripts were written to the session scratchpad only.
