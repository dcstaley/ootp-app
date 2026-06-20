# CLAUDE.md — OOTP Roster Optimizer (rebuild)

From-scratch rebuild of an OOTP (Out of the Park Baseball) roster optimizer. Discovery, requirements,
and design are **complete** and captured in `docs/`. This file is the always-loaded operating context;
the docs hold the detail. Your job: propose an architecture/plan that reflects the settled decisions,
get it approved, then build it incrementally.

## The one principle (above all else)
**One scoring core, computed once, consumed identically by every part** (data grid, optimizer, single
player, training validation). Most of the old app's bugs came from scoring/calibration logic existing
in multiple places and drifting. Enforce this structurally: one program, one language (TypeScript
end-to-end), one shared scoring module; solver in-process (HiGHS-WASM); data as plain files in one
folder. If you ever find yourself writing scoring math in a second place, stop.

## Folders
- **This folder** (`C:\dev\ootp-app`) = the new app. Build here.
- **`docs/`** = the rebuild reference docs (read order below) + format samples.
- **`Model 2037 and 2038/`** = real sim outcome data for model training (see Reference data).
- **`C:\ootp_app`** = the OLD codebase, **reference only** for current behavior and validation numbers.
  Do not copy its architecture; the rebuild re-architects everything. Where old code and docs conflict,
  the code is the factual record of current behavior, but the docs hold the *decisions* for the rebuild.

## Read before doing anything (in order, all in `docs/`)
1. `OOTP_Optimizer_Handover.md` — original intent + feature set (strong but not always accurate; the
   findings doc corrects it).
2. `REBUILD_DISCOVERY_FINDINGS.md` — what the current code actually does, file by file, + bugs/root
   causes. The evidence base.
3. `REBUILD_REQUIREMENTS_AND_DECISIONS.md` — requirements (Part A) + settled decisions **D1–D7**
   (Part B). These are made; build to them, don't relitigate.
4. `REBUILD_ARCHITECTURE.md` — the architecture (plain-language Parts 0–5, engineer appendix Part 6)
   + the build order.

## Workflow
1. Read everything above + skim the old code. **Propose an architecture and build plan, confirm your
   understanding, and ask clarifying questions. Do NOT write app code until the plan is approved.**
2. Build incrementally in `REBUILD_ARCHITECTURE.md` Part 5 order — **scoring core first** — validating
   each step against the old app's outputs before moving on.

## Hard rules
- Plan-and-approve before code (above). Prefer expressing logic in the right single place over patching.
- **Decisions D1–D7 are settled — build to them.** Summary:
  - **D1** scoring pipeline: basic score = direct from ratings; wOBA = event pipeline with the anchor
    applied AFTER era/park; all cards normalized to 600 PA.
  - **D2** cross-pool comparability = signed distance from a common baseline, sign-flipped for pitchers
    (`hitter = wOBA − baseline`, `pitcher = baseline − allowedWOBA`); no power transform. Role/slot
    weights + both-sides bonus apply in cap/slots modes only.
  - **D4** the Tournament is the single config source; Era + Park are reusable libraries referenced by
    id; weights + softcaps are tournament-scoped (softcaps model-seeded); the global coeff bag dissolves.
  - **D5** keep the starters-first optimizer decomposition; replace greedy fill/coverage with
    principled matching/assignment; backup catcher = a coverage-depth constraint (retire the 3-pass);
    cap-reclaim stays but deterministic.
  - **D6** PT Account: 2 accounts (don't hard-code; allow N), `owned` is a quantity in the CSV, filter
    `owned > 0`, active-account selector scopes grid + variants + generation. PT-only (not SP).
  - **D7** consolidated file-based persistence; no IndexedDB/localStorage/sessionStorage sprawl.
- **D3 (model functional form) is deferred** — decided later from real data via a bake-off. Build the
  prediction model as a **swappable component behind a clean interface**, with a comparison harness.
  Nothing downstream may assume how the model produces its numbers.
- Domain facts that must hold: park factors are compressed (`cp`, 0.26), era factors are not; BIP is
  derived and dependent hits recompute from it; no pitcher batting.

## Stack direction (recommended; finalize at planning)
Single TypeScript app, React UI, shared TS domain modules, HiGHS-WASM solver in-process, data as JSON +
CSV files in one folder. Open at start: desktop wrapper vs local server; confirm WASM solver speed on
real pool sizes.

## Reference data
- **PT import format:** `docs/pt_card_list.csv` (authoritative). Note: `owned` column = quantity;
  pitch-type columns use no-space spellings (e.g. `Circlechange`, `Knucklecurve`).
- **SP import format:** `Export.csv` in `C:\ootp_app` (authoritative for Single Player), if present.
- **Model training data:** `Model 2037 and 2038/` — real season outcome CSVs per (pool, split, year):
  `PEL` and `HD 450/451/452/453` leagues, each `vL`/`vR`, for 2037 and 2038. The trainer treats vL and
  vR as **separate observations** feeding one unified fit; split is detected from the filename (one
  file is named `HD 452 2038 vR.csv` with year before side — make filename split-detection robust to
  token order).
- **Alternate model (prior art for D3):** `recalibrate_pt_model.py` in `C:\ootp_app` — a standalone
  sequential conditional cubic-logistic model; not what the old app trains, useful for the bake-off.

## Definition of done for Step 1 (scoring core)
A single scoring module that, given a card's ratings + a tournament config, produces the per-(card,
side, role) value — and reproduces the current app's scores on the same inputs within a small tolerance,
with unit tests. No second copy of the scoring math anywhere.

## Conventions
- **Stack:** single TypeScript package, ESM (`"type": "module"`). Node 24 runs `.ts` scripts directly via
  type-stripping (no build step) — so relative imports use explicit `.ts` extensions and `import type`.
  Vitest for tests. No frontend/UI yet (deferred to the Data Grid step); packaging = local Node server +
  browser (decided; not built yet).
- **Commands:** `npm test` (parity), `npm run golden` (regenerate golden refs from captures),
  `npm run typecheck` (`tsc --noEmit`).
- **Module layout:**
  - `src/scoring-core/` — the ONE scoring core. `helpers.ts` (single copy of cp/softcap/park/ssp/gb),
    `basic.ts`, `woba.ts` (raw assembly + trusted calibration), `score-card.ts` (orchestrator → per-card
    score matrix), `index.ts` (public surface). If you write scoring math anywhere else, stop.
  - `src/model/` — D3 swappable event model behind `EventModel` (`predictHitting`/`predictPitching`);
    `log-linear.ts` is the current (parity) port. Nothing downstream assumes how events are produced.
  - `src/config/` — `types.ts` (Coeffs/CalScales/Derived/ScoringConfig — one bag for now; D4 separation
    is a later step), `derived.ts` (era_h / era_effective_hr).
  - `tools/golden/` — THROWAWAY validation harness. `old/` holds verbatim extracts of the old app's
    scoring code (formula bodies unchanged) used only to emit golden reference numbers. NOT app code;
    never import from `tools/` into `src/`.
  - `tools/capture-snippet.js` — pasted into the OLD app's console to export a tournament's
    `{coeffs, calScales}` for validation. `fixtures/captures/*.json` (inputs) → `fixtures/golden/*` (refs).
- **Validation:** parity is measured against the user's TRUSTED scores = the old Roster & Lineup page's
  calibrated `getHittingScore`/`getPitchingScore`, NOT the datagrid. Workflow: capture → `npm run golden`
  → `npm test`. `fixtures/captures/_synthetic.json` is a dev smoke-test only (invented coeffs, not the
  old dead defaults); real per-tournament captures are the true oracle.
- **Parity rule:** reproduce the old math exactly, quirks included (e.g. pitching uses raw `park_gap`
  while hitting uses `cp(park_gap)`; calibrated hitting BIP drops `adv_sf`). Flag quirks in comments as
  post-parity reconciliation candidates; never silently "fix" one during the port.
