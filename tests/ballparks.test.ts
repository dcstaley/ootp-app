// Parser parity for OOTP's pt_ballparks.txt → Park records. Uses a small synthetic
// sample (the real file lives in the user's game install) covering the column
// mapping, per-hand gap/triples, neutral/0 guarding, and duplicate-name → year.

import { describe, it, expect } from "vitest";
import { parseBallparks } from "../src/data/ballparks.ts";

const SAMPLE = [
  "year,lgID,team name,park name,BA LH,2B LH,3B LH,HR LH,BA RH,2B RH,3B RH,HR RH,2B Overall,3B Overall,pt_level,pt_id",
  // Fenway 2026 (real values) — name duplicated below, so expect a year suffix
  "2026,MLB,Boston Red Sox,Fenway Park,1.037544608,1.179594398,1.139308333,0.949590623,1.047479868,1.038815975,1.185153842,1.010430932,1.089584947,1.151278138,0,6",
  // Fenway 2012 (duplicate name)
  "2012,AL,Boston Red Sox,Fenway Park,1.02,1.10,1.05,0.96,1.03,1.04,1.10,1.00,1.07,1.08,5,150",
  // Neutral default with 0/blank factors → guarded to 1
  "2026,MLB,None,Heinsohn Ballpark,0,,,0,0,0,0,0,0,0,-1,1",
].join("\n");

describe("pt_ballparks parser", () => {
  const parks = parseBallparks(SAMPLE);
  const byId = new Map(parks.map((p) => [p.id, p]));

  it("maps the factor columns + per-hand gap/triples + metadata", () => {
    const fen = byId.get("park-6")!;
    expect(fen.avg_l).toBeCloseTo(1.037544608, 6);
    expect(fen.avg_r).toBeCloseTo(1.047479868, 6);
    expect(fen.hr_l).toBeCloseTo(0.949590623, 6);
    expect(fen.hr_r).toBeCloseTo(1.010430932, 6);
    expect(fen.gap).toBeCloseTo(1.089584947, 6);   // 2B Overall
    expect(fen.gap_l).toBeCloseTo(1.179594398, 6); // 2B LH
    expect(fen.gap_r).toBeCloseTo(1.038815975, 6); // 2B RH
    expect(fen.triple).toBeCloseTo(1.151278138, 6);
    expect(fen.year).toBe(2026);
    expect(fen.league).toBe("MLB");
    expect(fen.team).toBe("Boston Red Sox");
    expect(fen.ptLevel).toBe(0);
  });

  it("uses pt_id for the id and disambiguates duplicate names by year", () => {
    expect(byId.get("park-6")!.name).toBe("Fenway Park (2026)");
    expect(byId.get("park-150")!.name).toBe("Fenway Park (2012)");
  });

  it("guards 0 / blank factors to a neutral 1", () => {
    const h = byId.get("park-1")!;
    expect(h.name).toBe("Heinsohn Ballpark"); // unique name → no year suffix
    expect(h.avg_l).toBe(1); expect(h.hr_r).toBe(1); expect(h.gap).toBe(1); expect(h.triple_l).toBe(1);
  });
});
