// M3 (D6, S2.4b) — variant-export CSV parsing. The game exports a list of the
// account's variant cards; we keep only the Card IDs (the `CID` column) and
// recompute the v5 boost ourselves. The importer must pick the CID/Card ID
// column and IGNORE an unrelated `ID` column (a real export had a wrong `ID`
// column that must NOT be mistaken for the card id).

import { describe, it, expect } from "vitest";
import { parseVariantExport } from "../src/data/account.ts";

describe("parseVariantExport", () => {
  it("reads the CID column (real game export shape)", () => {
    const csv = "Name,CID\nRay Herbert,82964\nEd Brandt,83029\nJose Reyes,83602\n";
    const { ids, column } = parseVariantExport(csv);
    expect(column).toBe("CID");
    expect(ids).toEqual(["82964", "83029", "83602"]);
  });

  it("falls back to a 'Card ID' column", () => {
    const csv = "Card ID,Name\n101,A\n102,B\n";
    const { ids, column } = parseVariantExport(csv);
    expect(column).toBe("Card ID");
    expect(ids).toEqual(["101", "102"]);
  });

  it("rejects an unrelated 'ID' column (no false match)", () => {
    const csv = "ID,Name\n9468,Chris Welsh\n9289,Neil Wagner\n";
    const { ids, column } = parseVariantExport(csv);
    expect(column).toBeNull();
    expect(ids).toEqual([]);
  });

  it("dedupes repeated ids and skips blanks", () => {
    const csv = "Name,CID\nA,500\nB,500\nC,\n";
    const { ids } = parseVariantExport(csv);
    expect(ids).toEqual(["500"]);
  });
});
