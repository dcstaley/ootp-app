# CAPTURE RUNBOOK — the exact procedure that works (proven 2026-07-21)

For pulling cwhit observed tables with the in-app Claude browser. Follow VERBATIM.
The three failure modes that have burned sessions, in order of how they present:
(1) wrong origin — the homepage embeds the app in a CROSS-ORIGIN iframe you cannot script;
(2) selecting tables by element id — Shiny re-renders change the id constantly;
(3) chasing the blob download — from the agent browser it goes nowhere; the TSV is already
in memory. NEVER use downloads, curl, wget, or any file-export UI. NEVER retype numbers.

## Per-table procedure (repeat for each tournament × role)

1. NAVIGATE to `https://app.cwhitstats.com/stats/` — the APP origin, never
   `cwhitstats.com`. Verify with read_page that the sidebar controls are present.
2. SELECT the tournament with COMPUTER CLICKS on the sidebar (never JS value-setting —
   Shiny may not see synthetic events): Tournament type dropdown (`tourney_cat`), then
   Tournament (`tourney_key`), then click the Pitchers or Hitters tab. Wait for the table
   to populate (a read_page showing data rows, or ~5s).
   DO NOT touch `overall_val_min` (40 is the game floor; changing it does nothing).
   DO NOT try to set `pitcher_min_ip` programmatically (proven unreliable 2026-07-21) —
   capture at site defaults; our floors (BF≥600/PA≥500) apply at read time, ours-side.
3. INJECT the extractor: javascript_tool with the full contents of
   `tools/cwhit-capture-snippet.js` (defines `window.capture`).
4. RUN: javascript_tool `await capture('pit')` (or `'hit'`). This sets the DataTable page
   length to 5000, waits ~10s for Shiny to return the FULL set in one POST, builds the
   TSV in memory, stashes `window.__cap = { tsv, prov, len }`, and RETURNS the provenance
   object. (A download may also fire; IGNORE it entirely.)
5. LABEL GATE — before anything is saved, assert on the returned provenance:
   · `prov.tourneyLabel` / `prov.tourneyKey` match the tournament you intended (the
     Danksville rule — the site loads a default tournament if selection didn't propagate);
   · `prov.rows === prov.recordsTotal` (full depth actually returned);
   · `prov.dateStart/dateEnd` are the window you expect.
   Any mismatch ⇒ do not save; re-select and retry.
6. READ THE TSV IN SLICES: javascript_tool `window.__cap.len`, then
   `window.__cap.tsv.slice(0, 50000)`, `.slice(50000, 100000)`, … until exhausted.
7. WRITE the fixture with the Write tool:
   · Path: `fixtures/cwhit-capture-<date-tag>/cap__<tourneyKey>__<role>.txt`
     (tourneyKey verbatim from prov — it already carries the site's `__YYYYMMDD__`
     effective-from token; role = pit|hit).
   · First line = the provenance header in EXACTLY the July format:
     `# CAP key=<tourneyKey> role=<role> label=<tourneyLabel> type=<tourneyType>
      env=<env> variants=<variants> obsval=<valMin>-<valMax> minIP=<minIp>
      minPA=<minPa> dates=<dateStart>..<dateEnd> recordsTotal=<n> rows=<n>`
   · Then the TSV exactly as extracted (header row + data rows, full precision).
8. VERIFY: line count == rows + 2 (comment + header); spot-check first data line parses.
9. NEXT TABLE: same tab, go to step 2. Sequential, one tab, ~10s waits — gentle on his
   server. No loops without Derek's go-ahead on scope.

## Table-finding contract (inside the snippet — do not "fix" it)

Tables are found by COLUMN SIGNATURE, never by id (Shiny re-renders change ids):
pit = [Name, VAL, VLvl, Hand, IP] · hit = [Name, POS, VAL, VLvl, Hand, PA] (POS at index 1
on hitters ONLY — getting this wrong throws "table not found", which reads like a render
failure and burned the 2026-07-27 run for a session).

## Scope rules (see FORMAT_FACTS)

Routine re-pulls = OBSERVED tables only (projections are on-demand, coverage-matched or
full-pool-reduced-formats, never pwOBA-truncated). Fits on captures stay blocked until the
wide re-pull is declared complete by Derek. Every capture directory gets a date tag; never
overwrite a prior capture directory.
