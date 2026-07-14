// Batch-1 item 4 — the cwhitstats join layer. Parser is pinned against the REAL cached snapshot
// (fixtures/cwhit) so a re-scrape that changes the shape trips a test; the join's collision /
// fingerprint / unmatched paths are pinned on constructed cases (the real collision rate is ~3%,
// too sparse to exercise every branch).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pjoin } from "node:path";
import { parseCwhitPit, parseCwhitHit, parseCwhitMeta, IP_TO_BF } from "../src/eval/cwhit/parse.ts";
import { joinCwhit, joinKey, normalizeName, type JoinCard, type JoinObs } from "../src/eval/cwhit/join.ts";

const FIX = pjoin(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cwhit");
const read = (f: string) => readFileSync(pjoin(FIX, f), "utf8");

describe("cwhit parse — real snapshot", () => {
  it("parses a pitcher table with provenance + BF derived from IP", () => {
    const { meta, rows } = parseCwhitPit(read("cwhit-bronze-pit.tsv"));
    expect(meta.role).toBe("pit");
    expect(meta.format).toBe("Bronze Quick");
    expect(meta.coverageFrom).toBe("2026-06-28");
    expect(meta.totalInstances).toBe(891);
    expect(rows.length).toBe(100);
    const bob = rows[0]!;
    expect(bob.name).toBe("Bob Miller");
    expect(bob.val).toBe(69);
    expect(bob.hand).toBe("R");
    expect(bob.k9).toBeCloseTo(6.53, 2);
    expect(bob.bf).toBeCloseTo(bob.ip * IP_TO_BF, 6);
  });

  it("parses a hitter table with the full event breakdown", () => {
    const { meta, rows } = parseCwhitHit(read("cwhit-bronze-hit.tsv"));
    expect(meta.role).toBe("hit");
    expect(rows.length).toBe(100);
    const s = rows[0]!;
    expect(s.name).toBe("Giancarlo Stanton");
    expect(s.pos).toBe("RF");
    expect(s.hr600).toBeGreaterThan(0);
    expect(s.bbPct).toBeGreaterThan(0);
    expect(s.xbhPct).toBeGreaterThan(0);
  });

  it("every cached table parses to its advertised top-N with finite key fields", () => {
    for (const f of readdirSync(FIX).filter((x) => x.endsWith(".tsv"))) {
      const isPit = f.includes("-pit");
      const { meta, rows } = isPit ? parseCwhitPit(read(f)) : parseCwhitHit(read(f));
      expect(rows.length, f).toBeGreaterThan(0);
      if (meta.topN) expect(rows.length, f).toBeLessThanOrEqual(meta.topN);
      for (const r of rows) { expect(Number.isFinite(r.val), f).toBe(true); expect(r.name.length, f).toBeGreaterThan(0); expect(["R", "L", "S"]).toContain(r.hand); }
    }
  });

  it("parseCwhitMeta reads a Daily-format header", () => {
    const m = parseCwhitMeta("# Gold Cap Daily pitchers | coverage 2026-06-28 to 2026-07-12 | 40 of 120 Gold Cap Daily tournaments | top 100 by IP", "pit");
    expect(m.format).toBe("Gold Cap Daily");
    expect(m.instances).toBe(40);
    expect(m.topN).toBe(100);
  });
});

describe("cwhit join — keys & normalization", () => {
  it("normalizes diacritics/whitespace/case but keeps distinct names distinct", () => {
    expect(normalizeName("  José   Ramírez ")).toBe("jose ramirez");
    expect(joinKey("Bob Miller", 69, 0, "r")).toBe("bob miller|69|0|R");
    expect(joinKey("Bob Miller", 69, 0, "R")).not.toBe(joinKey("Bob Miller", 69, 5, "R")); // base vs v5 variant
  });
});

// Helpers for the join branch tests: primary = [roleSignal, babip] (assignment), validate = [k,bb,hr].
let rowSeq = 0;
const obs = (name: string, val: number, vlvl: number, hand: string, primary: number[], validate: number[], sample = 1000): JoinObs<string> =>
  ({ name, val, vlvl, hand, primary, validate, sample, row: `${name}#${rowSeq++}` }); // distinct row payload per obs (collisions share name)
const card = (cid: string, name: string, val: number, vlvl: number, hand: string, primary: number[], validate: number[]): JoinCard =>
  ({ cid, name, val, vlvl, hand, primary, validate });

describe("cwhit join — branches", () => {
  it("direct-joins unique keys and reports a validate concordance distance", () => {
    const r = joinCwhit([obs("Bob Miller", 69, 0, "R", [0.9, 0.293], [6.5, 2.6, 0.6])],
                        [card("c1", "Bob Miller", 69, 0, "R", [0.9, 0.29], [6.6, 2.5, 0.55])]);
    expect(r.stats.matchedUnique).toBe(1);
    expect(r.matched[0]!.via).toBe("unique");
    expect(r.matched[0]!.primaryDist).toBe(0);
    expect(r.matched[0]!.card.cid).toBe("c1");
  });

  it("flags a cwhit key with no our-card as unmatched", () => {
    const r = joinCwhit([obs("Ghost Card", 70, 0, "L", [0.1, 0.3], [8, 3, 1])], []);
    expect(r.stats.unmatched).toBe(1);
    expect(r.matched.length).toBe(0);
  });

  it("fingerprint-disambiguates a collision on the PRIMARY axes (role/BABIP), not K/BB/HR", () => {
    // Two distinct "Bob Miller 69 R": a starter (low BABIP-against) and a reliever (higher). Two
    // cwhit rows collide on the key; assignment must follow the primary axes even though the
    // validate (K/BB/HR) vectors are deliberately swapped-looking.
    const starter = card("SP", "Bob Miller", 69, 0, "R", [0.9, 0.285], [6.5, 2.6, 0.6]);
    const reliever = card("RP", "Bob Miller", 69, 0, "R", [0.05, 0.315], [8.4, 3.0, 0.7]);
    const oStarter = obs("Bob Miller", 69, 0, "R", [0.88, 0.288], [6.4, 2.7, 0.62]);
    const oReliever = obs("Bob Miller", 69, 0, "R", [0.07, 0.312], [8.2, 3.1, 0.68]);
    const r = joinCwhit([oStarter, oReliever], [starter, reliever]);
    expect(r.stats.matchedFingerprint).toBe(2);
    expect(r.stats.collisionKeys).toBe(1);
    const byRow = new Map(r.matched.map((m) => [m.obs.row, m.card.cid]));
    expect(byRow.get(oStarter.row)).toBe("SP");
    expect(byRow.get(oReliever.row)).toBe("RP");
  });

  it("drops (does not force) an assignment that fails the confidence margin", () => {
    // Two candidates equidistant from the obs on the primary axes → ambiguous → dropped + reported.
    const a = card("A", "Twin Card", 70, 0, "R", [0.5, 0.30], [7, 3, 0.8]);
    const b = card("B", "Twin Card", 70, 0, "R", [0.5, 0.30], [7, 3, 0.8]);
    const r = joinCwhit([obs("Twin Card", 70, 0, "R", [0.5, 0.30], [7, 3, 0.8]),
                         obs("Twin Card", 70, 0, "R", [0.5, 0.30], [7, 3, 0.8])], [a, b], { marginMax: 0.7 });
    expect(r.stats.droppedRows).toBeGreaterThan(0);
    expect(r.droppedCollisions[0]!.reason).toContain("margin");
    expect(r.stats.collisionLossPct).toBeGreaterThan(0);
  });
});
