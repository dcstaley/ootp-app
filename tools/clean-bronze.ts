// clean-bronze.ts — apply the ghost-cleaning module to the three Return-of-the-Bronze runnings
// and write cleaned copies to a NEW directory (source files are never touched).
//
//   run: node tools/clean-bronze.ts
//
// Bronze is a 128-team best-of-7 tournament, so expectedTeams = 128. A 16-team Bo5 "quicks"
// running would pass 16 instead (see EXPECTED_TEAMS below), which recomputes both the ghost
// count and the clean ceiling for that format.
import Papa from "papaparse";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import {
  detectGhostOpponents,
  cleanTournamentRows,
  type Row,
} from "../src/eval/tournament-clean.ts";

const EXPECTED_TEAMS = 128; // Bronze = 128, Bo7. (16-team Bo5 quicks → 16.)
const SRC_DIR = "Tournament Data/Return of the Bronze";
const OUT_DIR = "Tournament Data/Return of the Bronze - CLEANED";
const FILES = [
  "Return of the Bronze 5 July.csv",
  "Return of the Bronze 7 July.csv",
  "Return of the Bronze 11 July.csv",
];

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

if (!existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

console.log(`Ghost-cleaning Return of the Bronze (expectedTeams=${EXPECTED_TEAMS})`);
console.log(`  source: ${SRC_DIR}`);
console.log(`  output: ${OUT_DIR}\n`);

for (const file of FILES) {
  const parsed = Papa.parse(readFileSync(`${SRC_DIR}/${file}`, "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  const rows = parsed.data as Row[];

  const det = detectGhostOpponents(rows, EXPECTED_TEAMS);
  const { cleaned, removed } = cleanTournamentRows(rows, EXPECTED_TEAMS);

  const before = poolH600(rows);
  const after = poolH600(cleaned);

  // Preserve every column (from the parsed field list) and every non-removed row.
  const out = Papa.unparse(
    { fields: (parsed.meta.fields ?? []) as string[], data: cleaned },
    { newline: "\r\n" },
  );
  writeFileSync(`${OUT_DIR}/${file}`, out, "utf8");

  const flaggedStr =
    det.flagged.length > 0
      ? det.flagged.map((f) => `${f.org} (excess ${f.excess.toFixed(0)})`).join(", ")
      : "(none)";
  console.log(`${file}`);
  console.log(`  distinct teams : ${det.distinctTeams}`);
  console.log(`  nGhosts        : ${det.nGhosts}`);
  console.log(`  flagged        : ${flaggedStr}`);
  console.log(`  rows removed    : ${removed.length}  (${rows.length} → ${cleaned.length})`);
  console.log(`  pool H/600      : ${before.toFixed(1)} → ${after.toFixed(1)}\n`);
}

console.log(`Done. Cleaned copies written to: ${OUT_DIR}`);
