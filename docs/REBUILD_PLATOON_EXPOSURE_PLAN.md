# Platoon Exposure & Tournament-Model Environment — Plan

Status: **proposed** (2026-07-06). Captures the design from the 2026-07-06 exposure/scoring
session. Two parts: (A) the platoon-exposure structure we build **now** with league data;
(B) the tournament-specific-model environment handling we build **later**, when tournament
outcome data lands. Nothing here touches the cap/slots objective; it feeds the per-(card,
side) values + the E[wins] team-exposure the optimizer already consumes.

## Background: the bug this replaces

The vR/vL blend weights are hardcoded, not pool-derived: `platoonVR ?? 0.62` in `server.ts`
`rosterOptions` (a dead fallback — tournaments like Oaxaca set their own, e.g. 0.58), and
`resolvePitchSplit` pulls a global league artifact, not the tournament's pool. So a skewed
pool (e.g. 70% LHP) is scored with league-average exposure. See the field-split diagnostic
(`tools/field-split.ts`).

## Part A — Exposure = Baseline + Deployment (BUILD NOW)

Platoon exposure decomposes into two parts with **opposite portability**:

- **Baseline** = the field's handedness counts. Pool-specific, **ratings-only, not trained**.
  Recompute per tournament from its own eligible field (role-agnostic top-N BY RATING — see
  [[pool-role-agnostic-topx]]). Auto-specializes to a skewed pool. This is the large,
  first-order correction over the hardcoded constants.
- **Deployment** = the managed-platooning shift (asymmetric ~4–11pt pulls toward the
  favorable matchup; ~1pt for RHP-faces-RHB, ~11pt for LHP-faces-LHB). **Behavioral,
  roughly pool-independent, requires trained/realized data.** The transferable artifact is
  the deployment **delta**, NOT the raw splits.

Measured on Oaxaca (CDMX pool, N=100 field): field %RHP 0.62 vs realized `teamVR` 0.58;
RH-starter-faces-RHB field 0.479 vs realized 0.471 (~exact); LH-starter-faces-LHB field
0.384 vs realized 0.273 (the big deployment gap). Full-catalog count (0.71) is the WRONG
denominator — the field is the right one, and it closes ~70% of the error; deployment is the
structured residual.

### Three-tier resolution (one mechanism)

```
effectiveExposure(T) = baseline(T.field) + deployment(resolveSource(T))   // clamp, then manual overrides
resolveSource(T) = T.ownTrainedModel ?? T.boundModel ?? nearestTournamentModel ?? leagueModel
```

| tier | baseline from | deployment from | result |
|------|---------------|-----------------|--------|
| League (Oaxaca) | its own field | its own trained model | = realized (by construction) |
| Tournament, untrained | its own field | **league** model | best estimate (what we ship now) |
| Tournament, trained | its own field | its own model | realized; its deployment can serve other untrained tournaments |

"Realized" is the special case where the target pool IS the trained pool.

### Data model
- **Trained model**: add its field **baseline** (on the trained pool) + derived
  **`deploymentShift = realized − baseline`** (asymmetric). Tag `scope: league | tournament`.
- **Tournament**: stop storing a stale `platoon` snapshot; store a **binding** (`auto` |
  model id) + optional manual overrides. Baseline is computed live, never cached.
- Slots into the existing `resolvePitchSplit` chain.

### Application
Apply deployment in **logit/odds space** (bounded; shares near 0/1 like 0.27 misbehave under
additive-in-share). Ship a **fixed** transferred delta first (deployment-scales-with-pool is
a later refinement, gated on tournament data).

### UI
- **Model library**: per model, a `League`/`Tournament` tag + its deployment-shift table.
- **Tournament settings — "Platoon exposure"**: an **Exposure source** dropdown
  (`Auto (baseline + League deployment)` | `League model` | `<tournament model>` | `Manual`)
  + a live **provenance preview**: `Baseline (this pool)` → `Deployment (source)` →
  `Effective`, next to the old hardcoded value. Manual per-split overrides.

### Build order (Part A, now)
1. Productionize the field-baseline computation (from `field-split.ts`) into a reusable
   `src` module — role-agnostic top-N field, per (batter-hand, pitcher-hand) counts.
   **Open choice:** the exposure field's N + whether to usage-weight (BF/PA) the counts.
2. Extract `deploymentShift` from the (current league) model = realized − league baseline.
3. Resolution function replacing the `0.62/0.58` constants + the `resolvePitchSplit` fallback.
4. UI: exposure-source selector + provenance preview.

## Part B — Tournament-model environment handling (BUILD LATER, needs data)

The scoring "environment" is **four** mechanisms; a tournament-trained model wants different
things from each:

1. **Tournament adjustment (D4 event multipliers)** — the only literal league→tournament
   event *guess*. A trained tournament model measures it directly → **default OFF** for
   tournament models.
2. **Pool transform (scaling)** — lifts a pool's ratings toward "the frame the model trained
   in." For a tournament model that frame is the tournament, not the league → **reference =
   the model's own training frame** → identity for own-tournament, still correct when reused.
3. **Anchoring (calibrate to 0.320)** — under raw-poly it's `0.320 / anchorMean` over **this
   pool's** top-50; it anchors to the pool's OWN elite and **ranking is invariant to the
   level** (`expected-wins.ts` header). It is NOT importing league events → **KEEP** (it's
   the value zero-point, `valueFor = woba − 0.320`, and the E[wins] `lgWoba` are a matched
   pair — move them together or not at all).
4. **Era + park LEVEL** — the run environment. See neutralization below.

Plus a **category the model can't express**: the **park HANDEDNESS differential** (`hr_l` vs
`hr_r`). The model predicts from 5 ratings, never `Bats`, so it's handedness-blind and CANNOT
bake in the L/R split — it learns the blend. So park handedness must stay **external**,
applied per-hand at inference, regardless of what the model is trained on. Era is
handedness-neutral (pure level), so it contributes nothing to the split.

### Training data is neutral-env; tournaments are Path B
League training data is collected in a **neutral park, neutral era** (`loader.ts:13-16`) —
park/era are applied at inference, never baked. So the league model does **not** double-count.
Tournament data is **Path B**: raw outcomes with park/era baked in. → **neutralize on ingest.**

### Neutralization = inference run backwards
For each observation, **divide** the observed event rates by the **same** per-channel factors
inference multiplies by, using the tournament's park/era and the card's known `Bats` for the
per-hand park channels:

| channel | factor (divide out) |
|---------|---------------------|
| HR | `era_effective_hr × parkHR(bats)` |
| BB | `era_bb` |
| K | `era_k` |
| non-HR hits (BA) | `era_h × parkAvg(bats)` |
| XBH (gap) | `× era_gap × cp(park_gap)` |

Reuse the scoring core's ONE copy of these helpers (no second impl). **Guarantee:** because
inverse∘forward = identity on the env layer, there is **zero double-count by construction**,
regardless of whether the library factors are perfectly accurate (accuracy only affects how
clean the learned talent curve is). Handedness survives because it's stripped/restored using
`Bats`, which is known at every step *except* inside the model. (Rate-space division with outs
as remainder is first-order; mirroring the exact BIP recompute is the refinement.)

Result: the tournament model differs from the league model in exactly the **ratings→events
talent curve** — the real signal — with env external and applied once.

### Rejected: separate models per hand
Splitting the model by fixed batter/pitcher hand does NOT help: park is external either way,
and the park library factor (full-park data) is a *better* estimate than a hand-split model
could learn from a small tournament sample. It only captures a residual hand-specific *talent*
curve, which OOTP's handedness-neutral ratings make ~0; if it exists, a hand **feature**
(partial pooling) beats a second model. Data fragmentation is near-fatal for tournaments.
Keep ONE structure (D3).

## Open items
- Exposure field N + usage-weighting (Part A step 1).
- Deployment: fixed transfer now; pool-scaling later (needs tournament data).
- **Verify** the era double-count path for a non-2010 tournament model (does the model encode
  environment, or is era applied on top — confirm against the trainer before Part B).
- Logit-space deployment application (spec when building Part A step 3).
