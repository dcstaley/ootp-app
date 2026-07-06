// Dataset integrity checks for training data — catch corrupt / duplicated / mislabeled files
// BEFORE they poison a model, and auto-EXCLUDE clearly-corrupt cells from modeling. Motivated
// by the 2039 corruption (HD450 vR was a byte-duplicate of vL; PEL vL held inflated data),
// which silently skewed the 39-40 platoon splits. Operates on the loader's per-(league, side,
// year) CellStats — no re-parsing.

import type { TrainingSummary, CellStat } from "./loader.ts";

export interface DatasetIssue { severity: "error" | "warn"; scope: string; message: string }
export interface DatasetValidation { ok: boolean; errors: number; warnings: number; excluded: string[]; issues: DatasetIssue[] }

// A closed league's total hitter PA equals total pitcher BF (every PA is one BF), so a year's
// PA/BF may differ only by rounding. Beyond this fraction ⇒ a corrupt/duplicated file.
const RECON_TOL = 0.003;

const byLeagueYear = (cells: CellStat[]): Map<string, { R?: CellStat; L?: CellStat }> => {
  const m = new Map<string, { R?: CellStat; L?: CellStat }>();
  for (const c of cells) { const g = m.get(`${c.league}|${c.year}`) ?? {}; g[c.side] = c; m.set(`${c.league}|${c.year}`, g); }
  return m;
};

/**
 * `${league}|${year}` cells that are UNAMBIGUOUSLY corrupt → excluded from ALL modeling. Only
 * the byte-identical vL/vR duplicate qualifies (a physically impossible coincidence); a merely
 * reversed split (vL ≥ vR) is left as a WARNING, not auto-dropped, since a genuinely LHP-heavy
 * environment can legitimately produce it. Key → human reason. Loader-shared so observations,
 * platoon splits, and wOBA weights all skip the same cells.
 */
export function corruptCellKeys(cells: CellStat[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, { R, L }] of byLeagueYear(cells))
    if (R && L && R.pa === L.pa && R.bf === L.bf && R.rows === L.rows)
      out.set(k, `vL and vR are identical (PA=${R.pa}, BF=${R.bf}, rows=${R.rows}) — one file is a duplicate of the other`);
  return out;
}

/** Full report for the UI. Corrupt cells are reported as EXCLUDED; the reconciliation +
 *  missing-side checks then run on the REMAINING (clean) cells so a fixed-by-exclusion year
 *  doesn't double-flag. */
export function validateDataset(summary: TrainingSummary): DatasetValidation {
  const issues: DatasetIssue[] = [];
  const add = (severity: "error" | "warn", scope: string, message: string) => issues.push({ severity, scope, message });

  const corrupt = corruptCellKeys(summary.cells);
  for (const [k, reason] of corrupt) add("error", k.replace("|", " "), `${reason} — EXCLUDED from modeling`);
  for (const f of summary.unparsedFiles) add("warn", "files", `unparsed file (name gave no league/side/year): ${f}`);

  // Reconciliation + coverage run on the cells that actually FEED the model (exclusions removed).
  const clean = summary.cells.filter((c) => !corrupt.has(`${c.league}|${c.year}`));
  const byYear = new Map<number, { pa: number; bf: number }>();
  for (const c of clean) {
    const y = byYear.get(c.year) ?? { pa: 0, bf: 0 };
    y.pa += c.pa; y.bf += c.bf; byYear.set(c.year, y);
    if (c.rows === 0 || (c.pa === 0 && c.bf === 0)) add("warn", `${c.league} ${c.year} v${c.side}`, `empty cell (rows=${c.rows}, PA=${c.pa}, BF=${c.bf})`);
  }
  for (const [year, { pa, bf }] of [...byYear].sort((a, b) => a[0] - b[0])) {
    if (bf > 0 && Math.abs(pa - bf) / bf > RECON_TOL)
      add("error", `${year}`, `hit PA (${pa.toLocaleString()}) ≠ pit BF (${bf.toLocaleString()}), off by ${((pa - bf) / bf * 100).toFixed(2)}% — a closed league must reconcile; an unidentified corrupt file remains`);
  }
  for (const [k, { R, L }] of byLeagueYear(clean)) {
    if (!R || !L) { add("warn", k.replace("|", " "), `missing ${R ? "vL" : "vR"} side`); continue; }
    if (L.pa >= R.pa) add("warn", k.replace("|", " "), `vL PA (${L.pa.toLocaleString()}) ≥ vR PA (${R.pa.toLocaleString()}) — expected vR > vL (RHP majority); investigate (a swapped/corrupt file, or a genuinely LHP-heavy environment)`);
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  return { ok: errors === 0, errors, warnings: issues.length - errors, excluded: [...corrupt.keys()], issues };
}
