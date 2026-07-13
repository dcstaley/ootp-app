import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import Papa from "papaparse";
import {
  detectGhostOpponents,
  cleanTournamentRows,
  type Row,
} from "../src/eval/tournament-clean.ts";

const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// H/600 pool rate for a set of rows — the metric the real-data guard tracks toward the
// clean-running baseline (July-11 ≈ 135).
const poolH600 = (rows: Row[]): number => {
  let h = 0;
  let pa = 0;
  for (const r of rows) {
    h += num(r.H);
    pa += num(r.PA);
  }
  return pa > 0 ? (h * 600) / pa : 0;
};

describe("detectGhostOpponents — synthetic", () => {
  it("flags exactly the injected extreme-excess team on an otherwise smooth pool", () => {
    // Build a smooth pool: 32 teams, each ~9 rows of ordinary lines with mild per-team variation.
    const rows: Row[] = [];
    for (let t = 0; t < 32; t++) {
      const org = `Team ${t}`;
      // mild spread so the pool has a natural (smooth) top; nothing here should be flagged.
      const bump = (t % 5) - 2; // −2..+2
      for (let g = 0; g < 9; g++) {
        rows.push({
          ORG: org,
          PA: 40,
          BB: 4 + bump * 0.2,
          "1B_1": 7 + bump * 0.2,
          "2B_1": 2,
          "3B_1": 0,
          HR: 1,
          H: 10 + bump * 0.2,
        });
      }
    }
    // Inject ONE ghost-opponent: same team footprint but grotesque offense on real volume.
    const ghost = "Ghostbeater FC";
    for (let g = 0; g < 9; g++) {
      rows.push({
        ORG: ghost,
        PA: 55,
        BB: 12,
        "1B_1": 18,
        "2B_1": 8,
        "3B_1": 1,
        HR: 9,
        H: 36,
      });
    }
    // expectedTeams = 33 → distinct = 33 would be nGhosts 0; make one team "missing" so nGhosts = 1.
    // We have 33 distinct orgs; pass expectedTeams = 34 to assert exactly one flag.
    const res = detectGhostOpponents(rows, 34);
    expect(res.nGhosts).toBe(1);
    expect(res.flagged).toHaveLength(1);
    expect(res.flagged[0]!.org).toBe(ghost);
    // its excess should dominate the runner-up substantially.
    const all = detectGhostOpponents(rows, 34 + 33).flagged; // force-rank everything
    expect(all[0]!.org).toBe(ghost);
    expect(all[0]!.excess).toBeGreaterThan(all[1]!.excess * 3);

    const { cleaned, removed } = cleanTournamentRows(rows, 34);
    expect(removed).toHaveLength(9);
    expect(cleaned.every((r) => String(r.ORG) !== ghost)).toBe(true);
    expect(poolH600(cleaned)).toBeLessThan(poolH600(rows)); // removing the ghost lowers the pool
  });

  it("removes nothing when the field is complete (nGhosts = 0)", () => {
    const rows: Row[] = [];
    for (let t = 0; t < 10; t++) {
      rows.push({ ORG: `Team ${t}`, PA: 40, BB: 4, "1B_1": 7, "2B_1": 2, "3B_1": 0, HR: 1, H: 10 });
    }
    const res = detectGhostOpponents(rows, 10);
    expect(res.nGhosts).toBe(0);
    expect(res.flagged).toHaveLength(0);
    const { removed } = cleanTournamentRows(rows, 10);
    expect(removed).toHaveLength(0);
  });
});

const BRONZE_DIR = "Tournament Data/Return of the Bronze";
const readCsv = (file: string): Row[] =>
  Papa.parse(readFileSync(`${BRONZE_DIR}/${file}`, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data as Row[];

describe.skipIf(!existsSync(BRONZE_DIR))("detectGhostOpponents — real Bronze data", () => {
  const EXPECTED = 128;

  it("July-7 flags Portsmouth Wunderfunk (one ghost)", () => {
    const rows = readCsv("Return of the Bronze 7 July.csv");
    const res = detectGhostOpponents(rows, EXPECTED);
    expect(res.nGhosts).toBe(1);
    expect(res.flagged[0]!.org).toBe("Portsmouth Wunderfunk");
    expect(res.flagged[0]!.excess).toBeGreaterThan(150);
  });

  it("July-5 flags DC Capital Giants (one ghost)", () => {
    const rows = readCsv("Return of the Bronze 5 July.csv");
    const res = detectGhostOpponents(rows, EXPECTED);
    expect(res.nGhosts).toBe(1);
    expect(res.flagged[0]!.org).toBe("DC Capital Giants");
    expect(res.flagged[0]!.excess).toBeGreaterThan(150);
  });

  it("July-11 (128 teams) flags nothing", () => {
    const rows = readCsv("Return of the Bronze 11 July.csv");
    const res = detectGhostOpponents(rows, EXPECTED);
    expect(res.nGhosts).toBe(0);
    expect(res.flagged).toHaveLength(0);
  });

  it("removing the flagged team pulls pool H/600 toward the clean July-11 baseline (~135)", () => {
    const baseline = poolH600(readCsv("Return of the Bronze 11 July.csv"));
    expect(baseline).toBeGreaterThan(130);
    expect(baseline).toBeLessThan(140);

    for (const file of ["Return of the Bronze 7 July.csv", "Return of the Bronze 5 July.csv"]) {
      const rows = readCsv(file);
      const before = poolH600(rows);
      const { cleaned } = cleanTournamentRows(rows, EXPECTED);
      const after = poolH600(cleaned);
      // inflated before → cleaning moves it DOWN and CLOSER to the clean baseline.
      expect(after).toBeLessThan(before);
      expect(Math.abs(after - baseline)).toBeLessThan(Math.abs(before - baseline));
    }
  });
});
