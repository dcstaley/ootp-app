# OOTP Optimizer Rebuild — Architecture Proposal

Capstone of the discovery + decisions work. Reads alongside:
- `REBUILD_DISCOVERY_FINDINGS.md` — evidence (what the current app does).
- `REBUILD_REQUIREMENTS_AND_DECISIONS.md` — confirmed requirements + decisions D1–D7.

**This doc is written plain-language first** (Parts 0–5, for validating the logic and behavior) with an
**engineer-facing appendix** (Part 6, for the build in Claude Code). The single most important
principle throughout: **one scoring core, computed once, consumed identically everywhere.**

---

## Part 0 — The one idea that drives everything

Most of this app's historical bugs came from the scoring math existing in more than one place (two
languages kept in sync by hand, plus the optimizer re-deriving its own version). The architecture's
whole job is to make that impossible. The way it does that:

> **The app is one program, in one language, with one scoring core. Every screen and the optimizer all
> call that same core. There is no second copy to drift out of sync.**

Everything below is in service of that.

---

## Part 1 — How it runs (deployment shape)

- **One application you launch once** and use in a browser window on your own computer.
- **One language end to end**, so the scoring core is a single shared piece of code — not a browser
  copy plus a backend copy.
- **The solver runs inside the same program** (no separate Python process to manage).
- **Your data lives as plain files in one folder** you can see, back up, and move between machines —
  your card lists (per account), tournaments, eras, parks, trained models, and saved rosters.

Why this shape: simplest thing to run for a single user, and it structurally enforces the one-core
principle (Part 0). Specific technology choices are in Part 6; they don't change the behavior.

---

## Part 2 — The big picture (how data flows)

```
   Card catalog  ──┐
   (shared ratings)│
                   ├──►  SCORING CORE  ──►  one value per (card, side, role)
   Account overlay │      (the ONE place)         │
   (owned, variants)                              │ consumed identically by ▼
                                                  │
   Tournament  ──► (era + park libraries,         ├─►  Data Grid (browse/scored)
   the single      softcaps, weights, rules)      ├─►  Roster Optimizer
   config source) ───────────────────────────────┤ ─►  Single Player view
                                                  └─►  Training validation
```

Read it as: ratings + account ownership come in; the tournament supplies the run-environment and rules;
the scoring core turns all of that into one number per card-per-side-per-role; and every feature reads
those same numbers. Nothing recomputes scoring on its own.

---

## Part 3 — The parts of the app, and what each does

### A. Data layer — your stuff, as files
- **Card catalog:** the universe of cards and their ratings (shared; a card is the same card for
  everyone). Imported from a `pt_card_list.csv`.
- **PT account overlays (D6):** two accounts (built so more is possible later). Each is one imported
  CSV; what's account-specific is the `owned` quantity (and that account's variants). The catalog is
  shared; the overlay says "this account owns these, in these quantities, with these variants."
- **Variants:** account-scoped boosted copies of owned cards, stored as overlay rows. *(As built:
  variants are a single **v5** boost, not levels 1–5; the v5 boost is always recomputed by us and the
  game's own level/ratings are ignored.)*
- **Libraries:** saved Tournaments, Eras, Parks, and trained Models — each a set of files.

### B. The scoring core — the one place (D1, D2)
This is the heart. It takes a card's ratings plus the active tournament's environment and produces the
final value used everywhere.
- **Two score types, one module each:**
  - *Basic* = a direct score from ratings (no event modeling).
  - *wOBA* = the event-based pipeline: predict events → apply per-event calibration to neutral
    baselines → apply era/park → recompute balls-in-play and dependent hits → assemble wOBA →
    normalize the pool to a common reference **after** era/park. All cards normalized to 600 PA.
- **Comparing hitters and pitchers (D2):** every card's value is its **signed distance from a common
  baseline** — for hitters `wOBA − baseline`, for pitchers `baseline − allowedWOBA`. Same unit, same
  "higher = better" direction, so the optimizer can weigh a bat against an arm honestly. No arbitrary
  power transform; the natural balance comes from each pool's real spread.
- **The prediction model is a swappable part (D3):** the core asks a "model" for event predictions
  through a fixed plug. Which model (log, cubic, sequential, etc.) is undecided and gets chosen later
  from real data — without touching anything else.
- **Computed once:** scoring runs once per card and the result is what every screen and the optimizer
  read. The optimizer never re-derives it.

### C. Configuration — the tournament is the single source (D4)
- **One tournament defines a generation completely:** roster shape, cap/slots rules, eligibility,
  position requirements, metrics, pool sizes, owned-only. Selecting a tournament *is* the setup — no
  separate "load into settings" step.
- **Eras and Parks are reusable libraries** the tournament points to (pick an era, pick a park).
- **Softcaps live with the tournament** (because the right values depend on the card pool), but
  training suggests starting values.
- Park factors are compressed, era factors are not — a fixed rule of how the game works, kept in the
  core.

### D. The roster optimizer (D5)
> **AS BUILT (superseded design):** the cap/slots optimizer is now a **single MILP with an E[wins]-derived
> objective** — each card's coefficient is its run contribution (value × playing-time from the usage model),
> so the budget allocation is combinatorial and native (no reserve→greedy→reclaim; the SP/relief
> double-count is netted; bullpen leverage slots + the two-way disjunction + preference-weight dials all
> live in the one solve). The "starters-first decomposition" language below describes the original plan;
> see `docs/REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md` for the shipped objective.
- **Picks the best roster + vL/vR lineups + rotation/bullpen** under the tournament's rules, reading
  the scoring core's values as-is.
- **Starters first, on purpose:** in cap/slots mode, starters are worth far more than bench, and you
  set explicit small budgets for bench/backup-catcher/swingman/relievers. So the optimizer spends the
  real budget on starters, then fills the cheap support roles within their budgets. (In non-cap mode
  there's no budget — it just picks the best roster meeting the requirements.)
- **The fixes vs. today are about quality, not structure:** the support fill and the defensive-coverage
  checks become *principled* (a real "can these players actually cover every position in both lineups,
  with backups?" check) instead of the greedy guesses that caused wrong picks (the "Arozarena" case)
  and catcher misfires. Backup catcher becomes a simple "need two" requirement, retiring the 3-pass
  workaround.
- **Required/locked and excluded cards, two-way players, and the bonus slot** are handled inside the
  optimization, not patched afterward.

### E. Manual editing
- After generation you can drag cards in/out of the roster and players into lineup slots, lock players
  to positions, and re-optimize — all ranked by the *same* scoring core, so manual and automatic agree.

### F. Model training + comparison (D3)
- Fits prediction models from outcome CSVs (vL and vR as separate observations into one model;
  volume-weighted; aggregates duplicate cards).
- Produces diagnostics (residuals by weighted volume, over-valuation signal). *(As built: **softcaps are
  no longer a tournament feature** — the raw-poly event model replaced the softcap band-aid; softcap
  fields still pass through data untouched, retirement pending. Model-seeded softcaps are not produced.)*
- Adds a **comparison harness**: fit several model forms, score them against the diagnostics on real
  data, pick the best. This is where the deferred D3 decision gets made.

### G. The views (consumers of the core)
- **Data Grid:** browse every card with its scored columns; sort/filter/search; show/hide/reorder
  columns; named presets; highlight roster membership; scoped to the active account.
- **Single Player:** the same engine on a different import format — a column adapter maps SP columns to
  the standard names, plus Potential-rating scoring. Not a separate engine.

---

## Part 4 — The one-core contract (the through-line, stated precisely)

- **Input:** a card's ratings + the active tournament's environment/config + the active account overlay.
- **Output:** one final value per (card, side, role), plus the component pieces for display.
- **Rule:** every consumer — Data Grid, optimizer, manual editing, SP, training validation — reads
  these values. None recomputes scoring. The optimizer uses them directly as its objective numbers.
- Because the app is one program in one language, there is **no boundary to pass a "modifiers" bundle
  across** and no second implementation to keep in sync. The class of bug that dominated the old app is
  removed by construction.

---

## Part 5 — Suggested build order (incremental, validate each step)

> **Note:** step 1's "check its numbers against the current app" parity check is **obsolete** — old-app
> parity was sunset (2026-07-01) and the scoring core is now validated against the deployed raw-poly
> event model + the test suite, not the old app.

1. **Scoring core + one model** (even today's log model) → check its numbers against the current app on
   the same cards. This is the foundation; get it right first.
2. **Data layer + config** (card catalog, account overlays, tournament/eras/parks libraries).
3. **Data Grid** (first consumer) → eyeball scored cards, confirm the core feels right.
4. **Optimizer** (starters-first + principled support fill + real coverage check) → validate rosters
   against known-good current outputs.
5. **Manual editing.**
6. **Training + comparison harness**, then the D3 model exploration with real data.
7. **Single Player** (adapter + potential).

Each step is usable and checkable before the next — and every step reads the one scoring core.

---

## Part 6 — Engineer-facing appendix (stack + interfaces)

**Stack recommendation.** Single TypeScript application; no separate frontend/backend codebases and no
cross-language scoring duplication. UI in React/TypeScript (reuses current familiarity and most UI
intent). All domain logic — scoring core, calibration, model interface, optimizer orchestration — in
shared TypeScript modules imported by both UI and compute. Solver: HiGHS via WebAssembly (`highs-js`),
run in-process (retires the Python subprocess; note `highs-js` was already present in the dead
`api/optimize.js`, so the WASM path is proven). Packaging: a local app (e.g. Tauri or Electron for a
one-click desktop window, or a single local server serving the SPA) — chosen at build start; both give
"launch once." Persistence: plain files in one app folder — JSON for libraries (tournaments, eras,
parks, models, account overlays, saved rosters) + CSV for imports; SQLite is a reasonable alternative
if relational queries become useful. Retire IndexedDB/localStorage/sessionStorage sprawl.

**Key module boundaries (sketch).**
- `scoring-core`: pure functions. `scoreCard(ratings, config) → { basic, woba } per side/role`, plus
  `valueFor(scoredCard, role) → signedDistanceFromBaseline`. Calibration/anchor computed over the
  eligible/top-X pool; era/park applied before the anchor; basic and wOBA both emit one final value.
- `model` (swappable, D3): `predictEvents(ratings) → {BB,K,HR,nonHRH,XBH per 600}`. Implementations:
  log-linear (port current), and candidates for the bake-off. Selected by the comparison harness.
- `config`: `Tournament` is the single source; references `Era` and `Park` by id; carries softcaps +
  weights + rules. No global mutable coeff store; model coefficients are model-scoped artifacts.
- `optimizer`: `generate(pool, tournament, account) → Roster`. Cap/slots: starters-first selection
  (role-weighted, signed-distance objective) within main budget; principled support fill within
  per-role sub-budgets; defensive feasibility via a matching/assignment check (covering≠matching);
  deterministic reclaim of unspent support budget; locks/excludes/two-way/bonus as in-model
  constraints; lineup assignment as a sub-solve. Non-cap: best roster meeting structural + positional
  constraints, unweighted. Consumes `scoring-core` values only.
- `persistence`: a repository over the app folder; account overlays first-class.
- `views`: Data Grid, Roster/Lineup, SP, Training — all read `scoring-core`.

**Decision traceability.** D1 → scoring-core pipeline & anchor-after-era/park & 600-PA. D2 →
`valueFor` signed-distance, no power transform. D3 → `model` plug + comparison harness. D4 → `config`
tournament-as-source + Era/Park libraries. D5 → `optimizer` starters-first + principled fill/matching.
D6 → account overlays + `owned>0` filter, quantity carried, selector scopes all PT views. D7 →
file-based persistence; single in-process app.

**Open at build start:** final packaging choice (desktop wrapper vs local server); confirm HiGHS-WASM
performance on real pool sizes (fall back to bundled native/Python only if needed); the D3 model form
(data bake-off).
