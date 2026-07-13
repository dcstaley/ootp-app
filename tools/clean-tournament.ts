// clean-tournament.ts — READ-ONLY diagnostic. Apply the PA−BF ledger ghost-cleaner to every running
// in a tournament directory and PRINT the report (status / ledger / flagged orgs / rows removed /
// pool H-600 before→after). It writes NO files — the retired "- CLEANED" mirror dirs are gone; the
// one source of truth is the raw CSV + the in-memory cleaner (src/eval/tournament-clean.ts), which
// the app and analysis tools apply on ingest.
//
//   run: node tools/clean-tournament.ts "Tournament Data/Early Gold"
//        node tools/clean-tournament.ts "Tournament Data/Return of the Bronze"
//        node tools/clean-tournament.ts            # defaults to both EG + Bronze
//
// The detector is ledger-based (ΣPA − ΣBF) + per-org PA/BF asymmetry — no external team count is
// needed (roadmap Batch 1). See src/eval/tournament-clean.ts for the method + validation.
import Papa from "papaparse";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  cleanTournamentRows,
  type Row,
} from "../src/eval/tournament-clean.ts";

const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const poolH600 = (rows: Row[]): number => {
  let h = 0;
  let pa = 0;
  for (const r of rows) {
    h += num(r.H);
    pa += num(r.PA);
  }
  return pa > 0 ? (h * 600) / pa : 0;
};

function cleanDir(srcDir: string): void {
  if (!existsSync(srcDir)) {
    console.error(`Source directory not found: ${srcDir}`);
    return;
  }
  console.log(`\n=== ${srcDir} (read-only report — no files written) ===`);

  const files = readdirSync(srcDir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort();
  for (const file of files) {
    const parsed = Papa.parse(readFileSync(`${srcDir}/${file}`, "utf8"), {
      header: true,
      skipEmptyLines: true,
    });
    const rows = parsed.data as Row[];
    const { cleaned, removed, report } = cleanTournamentRows(rows);
    const before = poolH600(rows);
    const after = poolH600(cleaned);

    const flaggedStr =
      report.flagged.length > 0
        ? report.flagged.map((f) => `${f.org} (imb ${f.imb}, asym ${(f.asym * 100).toFixed(1)}%)`).join(", ")
        : "(none)";
    console.log(`${file}`);
    console.log(`  status         : ${report.status}`);
    console.log(`  ledger PA−BF   : ${report.ledger}  → residual ${report.residual}  (tol ${report.tol.toFixed(0)})`);
    console.log(`  distinct orgs  : ${report.distinctOrgs}   entriesEst ${report.entriesEst}`);
    console.log(`  flagged        : ${flaggedStr}`);
    console.log(`  rows removed   : ${removed.length}  (${rows.length} → ${cleaned.length})`);
    console.log(`  pool H/600     : ${before.toFixed(1)} → ${after.toFixed(1)}`);
  }
}

const args = process.argv.slice(2);
const dirs = args.length
  ? args
  : ["Tournament Data/Early Gold", "Tournament Data/Return of the Bronze"];
for (const d of dirs) cleanDir(d);
console.log("\nDone.");
