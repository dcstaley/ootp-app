import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import Papa from "papaparse";
import {
  detectContamination,
  cleanTournamentRows,
  type Row,
} from "../src/eval/tournament-clean.ts";

const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const ledgerOf = (rows: Row[]): number => {
  let pa = 0;
  let bf = 0;
  for (const r of rows) {
    pa += num(r.PA);
    bf += num(r.BF);
  }
  return pa - bf;
};

// Build a "balanced" org: hitter rows (PA, no BF) matched by pitcher rows (BF, no PA) so PA ≈ BF.
function balancedOrg(org: string, paPerTeam: number): Row[] {
  const rows: Row[] = [];
  // ~13 hitters and ~12 pitchers; split the PA/BF budget so the org's own ledger ≈ 0.
  for (let i = 0; i < 13; i++) rows.push({ ORG: org, PA: Math.round(paPerTeam / 13), BF: 0, H: 10 });
  for (let i = 0; i < 12; i++) rows.push({ ORG: org, PA: 0, BF: Math.round(paPerTeam / 12), H: 0 });
  return rows;
}

describe("detectContamination — synthetic ledger", () => {
  it("clean field (ΣPA == ΣBF) flags nothing", () => {
    const rows: Row[] = [];
    for (let t = 0; t < 16; t++) rows.push(...balancedOrg(`Team ${t}`, 600));
    const r = detectContamination(rows);
    expect(Math.abs(r.ledger)).toBeLessThanOrEqual(r.tol);
    expect(r.status).toBe("clean");
    expect(r.flagged).toHaveLength(0);
  });

  it("a partial-export org (batting only, no pitching) is flagged and removal reconciles the ledger", () => {
    const rows: Row[] = [];
    for (let t = 0; t < 16; t++) rows.push(...balancedOrg(`Team ${t}`, 600));
    // Ghost opponent: 13 hitter rows with big PA, but its pitching lines never exported (BF = 0).
    const ghost = "Ghostbeater FC";
    for (let i = 0; i < 13; i++) rows.push({ ORG: ghost, PA: 60, BF: 0, H: 30 });
    const before = ledgerOf(rows);
    expect(before).toBeGreaterThan(700); // ~780 one-sided PA

    const det = detectContamination(rows);
    expect(det.status).toBe("cleaned");
    expect(det.flagged.map((f) => f.org)).toContain(ghost);

    const { cleaned, removed, report } = cleanTournamentRows(rows);
    expect(removed.length).toBe(13);
    expect(cleaned.every((r) => String(r.ORG) !== ghost)).toBe(true);
    expect(Math.abs(report.residual)).toBeLessThanOrEqual(report.tol);
    expect(Math.abs(ledgerOf(cleaned))).toBeLessThanOrEqual(report.tol);
  });

  it("does NOT flag an opposite-sign asymmetric org (blown-out team, not a partial exporter)", () => {
    const rows: Row[] = [];
    for (let t = 0; t < 16; t++) rows.push(...balancedOrg(`Team ${t}`, 600));
    // Positive-ledger contamination from a batting-only ghost.
    for (let i = 0; i < 13; i++) rows.push({ ORG: "Ghost FC", PA: 60, BF: 0, H: 30 });
    // An opposite-sign org (the Bronze "Oslo Royals" pattern): a SMALL blown-out team, BF > PA, so
    // high |asym| but WRONG sign vs the dominant +ledger and small magnitude — must NOT be flagged.
    for (let i = 0; i < 12; i++) rows.push({ ORG: "Blowout United", PA: 4, BF: 10, H: 1 });

    const det = detectContamination(rows);
    expect(det.flagged.map((f) => f.org)).not.toContain("Blowout United");
    expect(det.flagged.map((f) => f.org)).toContain("Ghost FC");
  });

  it("marks a smeared imbalance with no eligible culprit as unreliable (protects real winners)", () => {
    const rows: Row[] = [];
    for (let t = 0; t < 16; t++) rows.push(...balancedOrg(`Team ${t}`, 600));
    // Spread a modest positive imbalance across many BALANCED-ish orgs (each only ~6% asym) so no
    // single org clears the asymFloor — the ledger is off but nothing is cliff-safe to remove.
    for (let t = 0; t < 16; t++) rows.push({ ORG: `Team ${t}`, PA: 30, BF: 0, H: 8 });
    const det = detectContamination(rows);
    expect(Math.abs(det.ledger)).toBeGreaterThan(det.tol);
    // Every org stays near-balanced → below asymFloor → nothing eligible → unreliable, remove nothing.
    expect(det.status).toBe("unreliable");
    expect(det.flagged).toHaveLength(0);
  });
});

// ─── Real Return-of-the-Bronze data: the ground-truth validation ─────────────────────────────────
const BRONZE_DIR = "Tournament Data/Return of the Bronze";
const readCsv = (dir: string, file: string): Row[] =>
  Papa.parse(readFileSync(`${dir}/${file}`, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data as Row[];

describe.skipIf(!existsSync(BRONZE_DIR))("detectContamination — real Bronze data (ground truth)", () => {
  it("July-11 (known clean, ΣPA == ΣBF) flags nothing", () => {
    const r = detectContamination(readCsv(BRONZE_DIR, "Return of the Bronze 11 July.csv"));
    expect(r.ledger).toBe(0);
    expect(r.status).toBe("clean");
    expect(r.flagged).toHaveLength(0);
  });

  it("July-5 flags exactly DC Capital Giants and reconciles the ledger", () => {
    const r = detectContamination(readCsv(BRONZE_DIR, "Return of the Bronze 5 July.csv"));
    expect(r.ledger).toBeGreaterThan(300);
    expect(r.status).toBe("cleaned");
    expect(r.flagged.map((f) => f.org)).toEqual(["DC Capital Giants"]);
    expect(Math.abs(r.residual)).toBeLessThanOrEqual(r.tol);
  });

  it("July-7 flags exactly Portsmouth Wunderfunk (13.7% asym) and NOT the opposite-sign Oslo Royals", () => {
    const r = detectContamination(readCsv(BRONZE_DIR, "Return of the Bronze 7 July.csv"));
    expect(r.ledger).toBeGreaterThan(300);
    expect(r.status).toBe("cleaned");
    expect(r.flagged.map((f) => f.org)).toEqual(["Portsmouth Wunderfunk"]);
    expect(r.flagged.map((f) => f.org)).not.toContain("Oslo Royals");
  });

  it("removing the flagged org pulls pool H/600 toward the clean July-11 baseline (~135)", () => {
    const poolH600 = (rows: Row[]): number => {
      let h = 0;
      let pa = 0;
      for (const r of rows) {
        h += num(r.H);
        pa += num(r.PA);
      }
      return pa > 0 ? (h * 600) / pa : 0;
    };
    const baseline = poolH600(readCsv(BRONZE_DIR, "Return of the Bronze 11 July.csv"));
    expect(baseline).toBeGreaterThan(130);
    expect(baseline).toBeLessThan(140);
    for (const file of ["Return of the Bronze 7 July.csv", "Return of the Bronze 5 July.csv"]) {
      const rows = readCsv(BRONZE_DIR, file);
      const before = poolH600(rows);
      const { cleaned } = cleanTournamentRows(rows);
      const after = poolH600(cleaned);
      expect(after).toBeLessThan(before);
      expect(Math.abs(after - baseline)).toBeLessThan(Math.abs(before - baseline));
    }
  });
});
