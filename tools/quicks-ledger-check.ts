// Per-running PA−BF ledger diagnostic across the quicks tiers — finds partial-export (ghost) runnings.
// Fable flagged one gold-quicks file as ledger-imbalanced (the first real quicks anomaly). This runs the
// deterministic per-org asymmetry detector (src/eval/tournament-clean.ts) on every quicks file and prints
// the ledger, residual after cleaning, and the flagged orgs so the bad running can be cleaned or excluded.
//   run: node tools/quicks-ledger-check.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { detectContamination } from "../src/eval/tournament-clean.ts";

for (const [name, dir] of [
  ["Gold", "Tournament Data/Quicks - Gold"],
  ["Bronze", "Tournament Data/Quicks - Bronze"],
  ["Open", "Tournament Data/Quicks - Open"],
] as const) {
  console.log(`\n=== ${name} ===`);
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".csv"))) {
    const rows = (Papa.parse<Record<string, unknown>>(readFileSync(join(dir, f), "utf8"), { header: true, skipEmptyLines: true }).data ?? []).filter((r) => r && r["CID"] != null && String(r["CID"]) !== "");
    const rep = detectContamination(rows);
    const flag = rep.flagged.map((o) => `${o.org}(imb${o.imb.toFixed(0)},asym${(o.asym * 100).toFixed(0)}%)`).join(",");
    console.log(`${f.padEnd(26)} status=${rep.status.padEnd(10)} ledger=${rep.ledger.toFixed(0).padStart(6)} residual=${rep.residual.toFixed(0).padStart(6)} tol=${rep.tol.toFixed(0)} ${flag ? "flag:" + flag : ""}`);
  }
}
process.exit(0);
