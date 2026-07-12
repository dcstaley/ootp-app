# Audit Fix Handoff — 2026-07-11

Source: full application audit (2026-07-10, main @ b5db870) + follow-up decisions with Derek.
This doc is self-contained: everything needed to execute is here. Baseline at audit time:
171/171 tests pass, `typecheck` + `typecheck:web` clean, on-disk data referentially consistent.

## Ground rules (read first — these override instinct)

- **One scoring core.** All scoring/calibration math lives in `src/scoring-core/` + `src/model/`.
  If a fix tempts you to write event math elsewhere, stop and restructure.
- **Old-app parity is SUNSET.** Change scoring deliberately and freely; there is no golden
  baseline to preserve. Tests are self-consistent, not parity-anchored.
- **No auto-regenerate.** Roster edits set `dirty` and wait for manual Regenerate. Never
  reintroduce auto-regen, including in comments (see W-6 — the stale comments claim it exists).
- **Variants are always trained AND scored.** They are excluded ONLY from rating-scaling
  baselines (field/anchor selection). Nothing in this doc changes that invariant.
- **Don't kill dev servers** on 5173/8787; Derek may be watching 5173 live. No port sweeps.
- **No UI screenshots** — verify in text and point Derek at the page.
- Verification for every phase: `npm test`, `npm run typecheck`, **and** `npm run typecheck:web`
  (the root typecheck does NOT cover `web/`).
- Line numbers below were exact at audit time; treat as anchors, re-locate if drifted.
- Work in phases, commit per coherent unit. Phase 1 items S-1..S-3 shift scores — do them as
  one batch (see the note there).

---

## Phase 1 — Scoring correctness (do as one batch)

These three change produced numbers. Do them together, then compare before/after top-50
hitters + pitchers per role via `/api/debug/rank` / `/api/debug/pool` on a couple of
tournaments (e.g. `gold-quick`) and record the deltas in the commit message.

### S-1. M1: anchor-HBP omission → ~15-pt cross-role hitter-over-pitcher skew  [APPROVED via audit Tier 1]

- **Where:** `src/scoring-core/woba.ts:137-157` (`anchorHittingWoba`, `anchorPitchingWoba`).
- **What:** The anchor wOBAs omit the `w.hbp * adv_hbp` term that the trusted assemblies
  include (`woba.ts:115,133`). Calibration (`calibrate.ts:92-100`) scales the anchor top-50
  mean to `TARGET_WOBA = 0.320`; every trusted score then adds ~+7.4 pts of HBP on top. Under
  D2 (`valueFor`) that's +7.4 for every hitter and −7.4 for every pitcher — a constant
  cross-role bias in cap spend allocation, two-way decisions, and cross-role upgrades.
  The code comment marks it "for post-parity reconciliation" — parity is sunset; reconcile now.
- **Fix:** add `+ w.hbp * (coeffs.adv_hbp ?? 6)` to both anchor functions so anchor and trusted
  assemblies use identical event terms (ssp is already 1 under eventForm, so no ssp question).
- **Acceptance:** after recalibration, top-50 trusted hitter mean ≈ top-50 trusted pitcher
  allowed mean ≈ 0.320. Add a test asserting the anchor assembly equals the trusted assembly
  at sFinal=1 (same components, same weights). Expect `calibrate.test.ts` expectations to move.

### S-2. M2: hitting BIP convention mismatch (training vs recompute)  [APPROVED explicitly]

- **Where:** `src/scoring-core/woba.ts:52` vs `src/model/raw-poly.ts:32` and
  `src/training/forms.ts:90,101`.
- **What:** Training + the deployed model derive hitting BIP as
  `600 − BB − K − HR − 6 − 3 + 4` (HBP 6, SH 3, SF +4 → net constant −5). The env recompute
  uses `600 − BB_fin − adv_hbp − adv_sh − SO_fin − HR_fin` — no +4, and production configs
  carry `adv_sh = 4` (net constant −10). The fitted H-curve is therefore evaluated ~5 counts
  below its fit convention, hitting only. Pitching already matches (constant 6 both places,
  `woba.ts:81`, `raw-poly.ts:46`, `forms.ts:126`).
- **Fix (one-core style):** define the BIP constants ONCE — e.g. export
  `HIT_BIP_ADJ = 6 + 3 - 4` and `PIT_BIP_ADJ = 6` from `src/model/curves.ts` — and import them
  in `forms.ts`, `raw-poly.ts`, and `woba.ts`. In `hittingComponents`, when `eventForm` is
  present use `BIP_fin = max(600 − BB_fin − SO_fin − HR_fin − HIT_BIP_ADJ, 1)`; keep the
  legacy `adv_hbp + adv_sh` branch for the no-eventForm (retired log) path unchanged.
- **Acceptance:** `tests/raw-poly.test.ts` — the hitting comparison currently passes at a
  3e-3 tolerance that exists *because of this gap* (its comment says so; it tests at
  adv_sh=3). After the fix, tighten hitting to the same ~1e-9 the pitching path meets at
  neutral env. Note: the calibration anchor re-absorbs most of the level shift, so ranking
  moves should be small; sanity-check per the batch note above.

### S-3. SSP drift in pool-stats  [APPROVED explicitly]

- **Where:** `src/scoring-core/pool-stats.ts:33,38` (`cardRec`).
- **What:** `cardRec` applies the legacy same-side penalty (`ssp_adv_hitting` /
  `ssp_basic_pitching`, ×0.995) to the raw field-selection wOBA. The rest of the deployed
  pipeline forces ssp→1 under eventForm (`woba.ts:114,132`, `calibrate.ts:73`,
  `score-card.ts:65,100`). So field selection (pool transform) and the exposure baseline rank
  on a slightly different basis than scoring.
- **Fix:** thread eventForm-awareness into `cardRec` and its exports (`cardSideWobas`,
  `computeFieldStats`, `computeUnifiedFieldStats`) — a boolean or the `EventForm` itself; when
  present, pass ssp = 1. Update call sites: `src/server/server.ts:214` (reference field),
  `:261` (pool transform), `:630` (exposure baseline). `tools/field-split.ts` mirrors the
  selection — update it too or note the divergence in its header.
- **Acceptance:** with an active model, `cardRec` wOBAs are ssp-free; without one, unchanged
  behavior. Expect only marginal top-50 field membership changes; `pool-transform` and
  `exposure` tests should still pass (they don't exercise ssp), but confirm.

### S-4. Lineup-lock display regression (b5db870)  [Tier 1]

- **Where:** `src/optimizer/generate.ts:21-25,84` (`displayLineup`); lock plumbing
  `roster-lp.ts:312` (`lkpos`), `roster-lp.ts:87-96` (locked cards may use eligible-but-
  unqualified `playPositions`).
- **What:** b5db870 re-derives displayed lineups via `bestLineup(rostered, positions, side, 1)`
  (the no-inversion feature), discarding the MILP's `yh` solution. Lineup locks still warp the
  solve, but the displayed lineup can show the pinned card elsewhere/benched — and if the lock
  targets a position the card is eligible-but-unqualified for, `bestLineup` (which uses
  qualified `positions` only) can return null → **empty lineup while status says "Optimal."**
  Same mechanism makes the two-way "extra hitter must start" rule cosmetically violable.
- **Fix — preserve no-inversion, honor locks:** make the display re-match lock-aware: pass the
  lineup locks into `bestLineup` as forced assignments (locked card fixed at its pos/side,
  matching runs on the remainder), and for locked cards use their `playPositions` (eligible)
  set, not just qualified positions. Alternative if that fights the matcher: fall back to
  reading the MILP `yh` lineup whenever lineup locks are present. Either is acceptable;
  prefer the first (keeps no-inversion for the unlocked majority).
- **Acceptance:** new test — pool where the natural starter at C differs from a locked card;
  assert the returned `lineupVR/VL` shows the locked card at the locked position; assert an
  eligible-but-unqualified lock does not produce an empty lineup on Optimal status.

### S-5. Server hardening batch  [Tier 1]

All in `src/server/server.ts` unless noted. One commit is fine.

1. **Top-level try/catch** around the request handler (`server.ts:1346`): any thrown error →
   500 JSON `{error}`, never an unhandled rejection (Node 24 kills the process today).
   Malformed `JSON.parse` bodies currently crash via `/api/state:1770`,
   `/api/tournaments/save:1685`, `/api/position-metrics:1756`, `/api/accounts/rename:1778`,
   `/api/accounts/variants/toggle:1810`, `/api/training/models/save:1591` (parse is outside
   its try). A dangling era/park id in a tournament crashes `scoreTournament`
   (`server.ts:222`) → also becomes a 500 instead of a crash.
2. **Path traversal:** `/api/training/models/delete` (`server.ts:1608-1611`) passes raw `?id=`
   to `repo.delete` → `join(root, "trained-models", id + ".json")`
   (`persistence/repository.ts:69-72`). Sanitize in `repo.delete` itself (reject ids that
   don't match a safe slug pattern, e.g. `/^[a-z0-9-]+$/i`) so every collection is covered.
3. **Atomic writes + guarded loads:** `repository.ts:39-49` — `save()` should write
   temp-file-then-rename; `load()`/boot loading (`server.ts:59-79`) should catch per-file
   parse errors and fail with a message naming the bad file (skip-and-warn is acceptable for
   library collections; state can fall back to defaults) instead of the server never starting.
4. **Account-import collision:** `server.ts:1789-1798` — the `existing` lookup uses the raw
   `?id=` param *before* the `id = slug(name)` fallback, so creating a "new" account whose
   name slugs to an existing id overwrites it with `variantCardIds: []` (silent loss of
   variant flags). Re-slug first, then look up `existing`, then preserve variants.
5. **Stale derived caches:** `refreshCatalog()` (`server.ts:334-338`) clears only the score
   cache; `refFieldCache` (211-217) and `leagueBaselineCache` (638-645) are keyed by
   `${activeModelId}|${accountId}` so a same-account CSV re-upload (the routine new-cards
   workflow) leaves the pool-strength reference field and exposure baseline stale until
   restart. `refDCache` (727, the E[win%] .500 anchor) survives even model activation
   (`refreshActiveModel:1303-1312`). Add one `invalidateDerivedCaches()` that clears all
   derived caches, called from both `refreshCatalog` and `refreshActiveModel`.
6. **Catalog CSV guard (light):** `/api/accounts/import` accepts any CSV with a `Card ID`
   column as the new shared catalog. Validate the handful of required columns (per
   `docs/pt_card_list.csv` header) before committing `state.catalogSourceId`; reject with a
   400 naming what's missing.
- **Acceptance:** add a small server test file (spin up `createServer` on an ephemeral port or
  factor handlers to be callable): malformed body → 400/500 not crash; traversal id → 400;
  collision import preserves variants; re-upload invalidates derived caches (observable via
  `/api/debug/scaling` changing).

### S-6. Enforce `max_variants_on_roster`  [DECIDED: make it work]

- **Where:** `src/config/tournament.ts:102` defines it; `src/config/seed.ts:128,142` seeds it
  (0 and 5); nothing reads it. Constraint belongs in `src/optimizer/roster-lp.ts`.
- **What:** The tournament setting exists in the editor and the config but is enforced
  nowhere — a variants-limited tournament can emit an illegal roster.
- **Fix:** add a MILP constraint: Σ(roster-membership of variant candidates) ≤ the configured
  max, active whenever the tournament sets a value. Details to get right:
  - Count each rostered variant CARD once — a two-way variant occupying both a hitter and a
    pitcher membership var must not count twice (mirror the existing two-way netting used for
    roster size in `roster-lp.ts`).
  - Candidate variant-ness: the server emits variant rows as `id#V` display ids
    (`server.ts:~491`); confirm the candidate objects carry a variant flag and thread it into
    the LP builder if they don't yet.
  - Semantics of 0: check the eligibility layer first — if a tournament that disallows
    variants already excludes them from the candidate pool upstream, `0` is trivially
    satisfied; otherwise `0` must mean "no variants rosterable." Treat the value as a hard
    cap either way; do not special-case 0 as "unset" (absent/undefined = unset).
  - If the user's locks force more variants than the cap allows, that's an Infeasible —
    acceptable, same behavior as other lock conflicts.
- **Acceptance:** test in the Q-1 suite — a pool rich in strictly-better variant cards with
  `max_variants_on_roster: 2` produces a roster with exactly ≤2 variants (and the objective
  prefers the best 2); unset ⇒ unlimited; a two-way variant counts once.

---

## Phase 2 — Web reliability (`web/`)

Remember `npm run typecheck:web`. These share two root causes; fix the pattern, not 12 spots.

### W-1. Fetch lifecycle (fixes several races at once)
- **Where:** `web/state.tsx` — `generateRoster`/`fetchUpgrades` (:241-249), meta+cards load
  (:106-112); also `web/TournamentsPage.tsx:209-212` (exposure refetch keyed on `msg?.text`),
  `web/ModelTrainingPage.tsx:583-587` (`toggleYear` chains, `loadResid` has no loading flag).
- **What:** No AbortController/latest-wins guard anywhere except `refineUpgrades`. A ~5s
  generate started before a tournament/account switch installs the old scope's roster under
  the new scope's header; slow cards responses can permanently show tournament A's scores
  under tournament B's sidebar.
- **Fix:** a scope token (or AbortController) in `state.tsx`: increment on tournament/account
  change; every response checks it's still current before `set*`. Apply the same tiny helper
  to the page-level fetches listed.

### W-2. Error/busy handling pattern
- **Where:** `web/state.tsx:131-170` (account mutations), `:71` + `web/App.tsx:100` (global
  `err` never cleared), `.catch(() => {})` at `web/TournamentsPage.tsx:112,116,128,223`,
  `web/ErasParksPage.tsx:25`, `web/ModelTrainingPage.tsx:580`, `web/state.tsx:127`.
- **Fix:** try/finally around every `busy` mutation (a thrown fetch currently bricks the
  Accounts page until reload); clear `err` on next successful load or make it dismissible;
  replace swallowed catches with surfaced messages. Consider one shared `getJson`/`postJson`
  in `web/shared.ts` with uniform `r.ok` handling — that fixes the class.
- **Critical sub-case:** `TournamentsPage.tsx:126-129` — if `/api/tournament?id=` fails (or
  returns `{error}`), the editor silently keeps the previous draft while the list highlights
  the new selection, and the 500ms auto-save writes edits onto the WRONG tournament id. On
  load failure: show an error and clear/disable the editor until a load succeeds.

### W-3. Stale drag source after Regenerate
- **Where:** `web/RosterPage.tsx:458-464` — `addById` memo deps proxy list contents by
  `.length` (both capped at 100 by `NB_RENDER`), and `roster` is not a dep. After Regenerate
  the drag path resolves against the previous generation's rows (stale value/cost). The +Add
  button path is fine.
- **Fix:** include `roster` (or the rows arrays themselves) in the deps.

### W-4. Lineup swap eligibility hole
- **Where:** `web/LineupTab.tsx:75-87` (`changePos`).
- **What:** Assigning a taken position gives the displaced holder the mover's old position
  with no eligibility check → blank `<select>` value, bogus defense readout, no warning.
- **Fix:** if the displaced holder isn't eligible at the vacated position, bench him (or
  block the swap with a message). Keep the "Eligible vs Qualified" terminology straight:
  eligible = can play; qualified = eligible + meets def minimums.

### W-5. Tournament form validation
- **Where:** `web/TournamentsPage.tsx:287-291` (`numIn`), footer note "Roster size is fixed
  at 26"; only the empty-name case is validated (:181).
- **Fix:** (a) don't auto-save the transient `0` written the instant a field is cleared for
  retyping (debounce until valid, or only save parseable values); (b) inline-validate
  `hitters + pitchers === roster_size` and `min_starters ≤ pitchers`; block save with a
  visible message on violation. Today the failure surfaces later as solver "Infeasible" on a
  different page.

### W-6. Stale comments that contradict settled behavior (do with Phase 6, listed here for locality)
- `web/state.tsx:40` and `web/RosterPage.tsx:484-485` claim staff locks "auto-regenerate" —
  they set `dirty` and wait for manual Regenerate. Fix the comments, not the behavior.

---

## Phase 3 — Model training pipeline

### T-1. Variant representative-ratings for pitchers  [Tier 3]
- **Where:** `src/training/loader.ts:219-220`.
- **What:** Pooled observations pick representative ratings by highest **hitting PA** —
  0 for every pitcher row, so the comparison fires once (`0 > -1`) and pitcher rep ratings
  come from file-iteration order, not the most-used variant level. Outcomes sum across
  levels whose ratings differ → X/Y mismatch noise concentrated in pitcher variant
  observations (relevant to the open pitcher-overscoring investigation).
- **Fix:** select the representative by role-appropriate sample: `h.PA + p.BF` (covers both
  roles and two-ways). One line + comment. Retrain is NOT required by this change alone, but
  note it affects the next fit.

### T-2. CV fold key → `cid|side`, plus a one-time A/B  [DECIDED with Derek]
- **Where:** `src/training/evaluate.ts:13-17` (`foldOf`), used at `:27-28`; obs key format is
  `${cid}|${B|V}|${side}` (`loader.ts:194`).
- **Decision (Derek):** vL and vR are treated as different players (profiles can differ
  materially by side) → sides stay in independent folds. But base+variant are near-duplicates
  (same player, uniformly boosted ratings) → they must travel together.
- **Fix:** fold on `` `${o.cid}|${o.side}` `` instead of `o.key` (drop the B/V token). Keep
  the deterministic FNV hash. This changes ONLY which rows are hidden together in CV — no
  change to what's trained or scored (variants stay in everything).
- **A/B (one-time, report results to Derek before going further):** run `buildScoreboard`
  under three fold keys — current `cid|B|side`, new `cid|side`, full `cid` — same window/minN.
  Compare per-candidate CV metrics, the in-sample→CV gap, and whether any model *ranking*
  flips. Deliver a short table. Adopt `cid|side` regardless (decided); flag to Derek if full
  `cid` flips any ranking (that would mean the vL/vR channel was distorting selection).

### T-3. Gate model save on dataset validation + record it  [Tier 2]
- **Where:** `src/server/server.ts:1253-1298` (`saveTrainedModel`), `src/training/validate.ts`.
- **What:** You can currently train, persist, and activate a model over a dataset with
  outstanding reconciliation errors; only byte-identical vL/vR cells auto-exclude, and the
  artifact records nothing about validation state.
- **Fix:** run `validateDataset` at save; block (or require an explicit `force=true` param)
  when errors are outstanding; stamp the artifact with the validation summary (counts of
  errors/warnings/excluded cells) so a deployed model records what it was trained through.

### T-4. Artifact `formatVersion`  [Tier 2]
- **Where:** artifact assembly in `saveTrainedModel` (`server.ts:1233-1245`), checked in
  `refreshActiveModel` (`server.ts:1303-1312`).
- **What:** Evaluation-semantics changes (proof-case: the monotone-cap commit 846c8bf)
  retroactively change how already-persisted betas score, invisibly.
- **Fix:** add `formatVersion: 1` to new artifacts; on activation, warn loudly (server log +
  a field the UI can surface) when an artifact predates the current version. Bump the
  version in T-5 below.

### T-5. Monotone cap for decreasing quads (bake-off integrity)  [Tier 3]
- **Where:** `src/model/curves.ts:45-51` (`monoZ`).
- **What:** The cap handles only increasing quads (`b2 < 0`, clamp above the peak). For
  decreasing events (K/kRat, BB/CON, HR/HRR): `b2 > 0` (interior valley → curve turns UP past
  it) gets no cap; `b2 < 0` concave-decreasing gets the whole curve flattened at the vertex —
  and because the gate samples the capped curve, the flattening passes the gate invisibly.
  Deployed forms are unaffected (verified: the shipped HR vertex is far out of domain) — this
  biases bake-off *comparisons*, not production scoring.
- **Fix:** make the cap direction-aware: determine the event's intended monotone direction
  (sign of the linear term over the domain, or pass it in per event), then clamp only the
  violating tail (decreasing event: clamp past an interior valley; increasing: past an
  interior peak). Never wholesale-flatten; if the vertex sits at the domain's low end for a
  decreasing event, cap the RISING tail, not the whole curve. Have the gate sample the
  UNCAPPED curve so corruption is visible, and report when the cap is active.
- **Coupling:** this changes artifact evaluation semantics → do together with T-4 and bump
  `formatVersion`.

---

## Phase 4 — Test coverage

### Q-1. E[wins] cap/slots MILP suite  [Tier 2 — the biggest guardrail gap]
- **What:** No test passes `usageWeights`, `segmentWeights`, `staffLocks`, or `lineupLocks`.
  Everything e45ee3d + b5db870 added (zst bench netting, bullpen leverage slots, y2bh two-way
  disjunction, preference-weight dials) runs unguarded; existing cap-mode tests exercise the
  legacy weighted path production no longer takes (server always builds usageWeights for
  cap/slots, `server.ts:776`).
- **Build:** a synthetic-pool suite (small, fast pools) asserting: cap respected under
  usageWeights; a locked SP appears in the rotation and a locked RP in the pen; a lineup lock
  survives to the *returned* lineups (pairs with S-4); the two-way slot rule (occupying both
  a hitter and pitcher slot nets one roster spot; the bonus-slot regime); dials monotonicity
  (raising a segment's dial never lowers that segment's total value); zst netting (bench
  players don't earn starter BF).

### Q-2. Server smoke tests
- Covered by the S-5 acceptance list; put them in `tests/server.test.ts`. Optional stretch:
  extract `rosterCandidates` / `resolvePitchSplit` / `winParamsFor` into a testable module
  when touched — do NOT do a big server.ts refactor in this pass.

---

## Phase 5 — UX quick wins (`web/`)

1. **Defuse "Scoring ✓"** (`web/ModelTrainingPage.tsx:750`): the active model's green button
   silently calls `activateModel("")` → reverts live scoring to the RETIRED log-linear
   baseline. Make it a non-interactive badge; if a deactivation path must exist, separate
   control + confirm. (Preferred: remove the revert path — log-linear is retired.)
2. **Confirm model delete** (`ModelTrainingPage.tsx:753`): ✕ deletes a trained snapshot
   (possibly the active one) with no confirm; tournaments and variant-clears confirm.
   `window.confirm` is fine (house style).
3. **Sidebar keyboard nav** (`web/App.tsx:80-84`): nav items are `<a onClick>` with no href.
   Add `href={"#/" + r.id}` — routing is already hash-based.
4. **DataTable sticky header + numeric sort default** (`web/DataTable.tsx:142-158,112`):
   sticky header like CardsPage; first click on numeric columns sorts descending (CardsPage
   already does this at `CardsPage.tsx:177`).
5. **Cards page empty state** (`web/CardsPage.tsx:211-216`): when no catalog is imported,
   point to Accounts → Import ownership.
6. **Model Training stale copy** (`ModelTrainingPage.tsx:603-610` + file header comment):
   remove "This page is ingestion only for now…" — the page contains the fits, bake-off, and
   residuals it claims don't exist.

---

## Phase 6 — Docs, comments, dead code

1. **`docs/REBUILD_ROADMAP.md` rewrite (highest doc priority):** "Right now"/"Session
   handoff" instructions reference the removed golden harness (`npm run golden`); milestone
   map shows M6 🔜 (it's done — mark ✅; M7 ⬜ is accurate); backlog items 1/3/4 are done
   (splits audit, tournament page cleanup, hybrid upgrades); the cap/slots weights overhaul
   shipped (e45ee3d + b5db870). Item 2 (overscoring weak/extreme players, Stuff residual)
   remains the open modeling thread.
2. **`docs/REBUILD_ARCHITECTURE.md` annotations:** variants are v5-only (not levels 1–5);
   softcaps are no longer a tournament feature (retirement pending); build-order step-1
   parity check is obsolete; Part 6's D5 description superseded by the single-MILP E[wins]
   design (point at `docs/REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md`).
3. **`docs/REBUILD_REQUIREMENTS_AND_DECISIONS.md`:** one-line supersession notes on D2/D5
   (E[wins] objective) and mark D3 resolved (raw-poly hitting + StuffAug pitching).
4. **CLAUDE.md:** deployed-model reference says "league-39-40"; the active artifact is
   `league-40-41` — reword to "the active trained artifact (see data/state/app.json)" so it
   can't go stale again.
5. **Stale comments:** W-6 pair (auto-regenerate); `src/optimizer/roster-lp.ts:53-54`
   ("deferred" double-credit fix — it shipped); `src/scoring-core/woba-weights.ts:7` (points
   at nonexistent `src/training/woba-weights.ts`; derivation lives in
   `src/training/loader.ts:225-271`); `src/training/loader.ts:31,166` (`deriveWobaWeights`
   doesn't exist); `tests/raw-poly.test.ts:14` (references removed `tests/parity.test.ts`).
6. **Dead code — remove:** `COLLECTIONS.rosters` + the `rosters/` mention in
   `src/persistence/repository.ts` (Derek decided: NO saved-rosters feature), and unused
   `loadImport` (`repository.ts:80-84`). Leave the larger retirement bundle (log-linear,
   softcap fields, tHR, legacy weighted objective, test-only optimizer modules) ALONE — it's
   scheduled separately.

---

## Explicitly declined / do NOT build (Derek's decisions, 2026-07-10/11)

- **No saved rosters** — rosters stay regenerate-per-request; remove the dead collection (Phase 6.6).
- **Grid view state is fine in-memory** — do not persist it.
- **No named/saved column presets** yet.
- **No account deletion** yet.
- **Do not change** (audit-reviewed, intentionally left): synchronous solves on the request
  path; large `/api/cards` responses; persistence concurrency (single user); `window.prompt`
  for renames; residuals *refitting* the deployed form (correct design — it asks "where does
  this FORM miss"); evaluator-vs-MILP role-assignment disagreement and the display-lineup
  ρ=1 vs evaluator ρ (known, tiny, revisit only if win% drives fine decisions); the +10%
  extrapolation ceiling (couple to T-4 if ever touched); StrictMode double-generate (dev-only).

## Open items needing Derek's decision (do NOT implement without asking)

- **Full-`cid` CV grouping**: only if the T-2 A/B flips a ranking — present the table first.
- **M1 magnitude check**: after S-1, if cross-role value shifts look larger than ~7-8 pts per
  side in practice, pause and show Derek before/after examples.

## Suggested execution order

1. Phase 1 (S-1..S-3 as one scoring batch, then S-4, then S-5, then S-6)
2. Phase 4 Q-1 (locks in tests pair naturally with S-4 — acceptable to do Q-1 first)
3. Phase 2 (W-1/W-2 pattern fixes first; W-3..W-5 after)
4. Phase 3 (T-1, T-2+A/B, T-3, T-4+T-5 together)
5. Phase 5, Phase 6
