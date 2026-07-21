// EXECUTABLE PINS for the cwhit corpus registry + the read-time derived view (§15.9(c) doctrine:
// recorded conventions get test pins, not prose notes).
//
// What each pin is guarding, and why a comment could not:
//   · The top-N sort rule is NOT one rule — it differs by table and, for projections, by ROLE. Getting
//     it wrong selects the WRONG HUNDRED rows silently; nothing throws, the numbers just quietly
//     describe a different sample. That is exactly the failure class §15.8 records.
//   · The registry claims a `tournamentId` for 11 of 14 formats. A typo'd id is inert until something
//     resolves it, then it is a missing config at measurement time.
//   · `formats` defaulting to QUICK is the promise that made the seam safe to add at all.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pjoin } from "node:path";
import {
  CWHIT_CORPUS, CAPTURE_DIR_2026_07_21, LEGACY_TOP_N, topNView, rankKey,
  formatByKey, formatByLegacySlug, captureObsPath, captureProjPath,
} from "../src/eval/cwhit/corpus.ts";
import { QUICK } from "../src/eval/cwhit/sample.ts";

const ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p: string) => pjoin(ROOT, p);

describe("cwhit corpus registry", () => {
  it("keys and capture keys are unique, and every capture key carries its own key as a prefix", () => {
    expect(new Set(CWHIT_CORPUS.map((f) => f.key)).size).toBe(CWHIT_CORPUS.length);
    expect(new Set(CWHIT_CORPUS.map((f) => f.captureKey)).size).toBe(CWHIT_CORPUS.length);
    for (const f of CWHIT_CORPUS) expect(f.captureKey.startsWith(`${f.key}__`), f.key).toBe(true);
  });

  it("every declared tournamentId resolves to a real config on disk", () => {
    for (const f of CWHIT_CORPUS) {
      if (!f.tournamentId) continue;
      const p = abs(`data/tournaments/${f.tournamentId}.json`);
      expect(existsSync(p), `${f.key} → ${f.tournamentId}`).toBe(true);
      expect(JSON.parse(readFileSync(p, "utf8")).id, f.key).toBe(f.tournamentId);
    }
  });

  it("neutralEnv agrees with the config's own era/park (era-2010 + park-1)", () => {
    for (const f of CWHIT_CORPUS) {
      if (!f.tournamentId) continue;
      const t = JSON.parse(readFileSync(abs(`data/tournaments/${f.tournamentId}.json`), "utf8"));
      expect(t.eraId === "era-2010" && t.parkId === "park-1", `${f.key} (${t.eraId}/${t.parkId})`).toBe(f.neutralEnv);
    }
  });

  it("the five Quick tiers are exactly the QUICK ladder, in ladder order", () => {
    expect(CWHIT_CORPUS.filter((f) => f.type === "Quick").map((f) => f.legacySlug)).toEqual(QUICK.map((q) => q.tier));
  });

  it("legacy slugs are unique and resolvable both ways", () => {
    const slugs = CWHIT_CORPUS.map((f) => f.legacySlug).filter(Boolean) as string[];
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(formatByLegacySlug(s)!.legacySlug).toBe(s);
    for (const f of CWHIT_CORPUS) expect(formatByKey(f.key)!.key).toBe(f.key);
  });

  it("every registry entry has both capture files on disk, for both roles", () => {
    // The registry is the index of a corpus that is committed; a missing file means the registry and
    // the corpus have drifted, which is precisely what an index exists to prevent.
    for (const f of CWHIT_CORPUS) {
      for (const role of ["pit", "hit"] as const) {
        expect(existsSync(abs(captureObsPath(CAPTURE_DIR_2026_07_21, f, role))), `obs ${f.key} ${role}`).toBe(true);
        expect(existsSync(abs(captureProjPath(CAPTURE_DIR_2026_07_21, f, role))), `proj ${f.key} ${role}`).toBe(true);
      }
    }
  });

  it("the registry covers the capture directory exactly — no orphan files, no phantom entries", () => {
    const onDisk = readdirSync(abs(CAPTURE_DIR_2026_07_21)).filter((x) => x.endsWith(".txt")).sort();
    const expected = CWHIT_CORPUS.flatMap((f) => (["pit", "hit"] as const).map((r) => `cap__${f.captureKey}__${r}.txt`)).sort();
    expect(onDisk).toEqual(expected);
  });
});

describe("read-time top-N derived view", () => {
  // THE PIN THAT MATTERS: the projection cut is role-DIRECTIONAL. pwOBA is wOBA *allowed* for a
  // pitcher, so the best pitchers are the LOWEST and the best hitters the HIGHEST. A single
  // "sort descending" rule would hand back the 100 WORST pitchers and never fail.
  it("ranks observed tables by usage, descending, for both roles", () => {
    expect(rankKey("obs", "pit")).toEqual({ field: "ip", desc: true });
    expect(rankKey("obs", "hit")).toEqual({ field: "pa", desc: true });
  });

  it("ranks projected tables by pwOBA — ASCENDING for pitchers, DESCENDING for hitters", () => {
    expect(rankKey("proj", "pit")).toEqual({ field: "pwoba", desc: false });
    expect(rankKey("proj", "hit")).toEqual({ field: "pwoba", desc: true });
  });

  it("selects the best rows under each rule", () => {
    const pit = [{ pwoba: 0.34 }, { pwoba: 0.28 }, { pwoba: 0.31 }];
    expect(topNView(pit, "proj", "pit", 2)).toEqual([{ pwoba: 0.28 }, { pwoba: 0.31 }]);
    const hit = [{ pwoba: 0.34 }, { pwoba: 0.28 }, { pwoba: 0.31 }];
    expect(topNView(hit, "proj", "hit", 2)).toEqual([{ pwoba: 0.34 }, { pwoba: 0.31 }]);
    const obs = [{ ip: 100 }, { ip: 900 }, { ip: 400 }];
    expect(topNView(obs, "obs", "pit", 2)).toEqual([{ ip: 900 }, { ip: 400 }]);
  });

  it("is the identity at full depth and never mutates its input", () => {
    const rows = [{ ip: 3 }, { ip: 9 }];
    const copy = [...rows];
    expect(topNView(rows, "obs", "pit", undefined)).toBe(rows);
    expect(topNView(rows, "obs", "pit", 99)).toBe(rows);
    expect(rows).toEqual(copy);
  });

  it("keeps ties in their original order, so a view of an already-sorted table is its prefix", () => {
    const rows = [{ ip: 5, id: "a" }, { ip: 5, id: "b" }, { ip: 5, id: "c" }];
    expect(topNView(rows, "obs", "pit", 2).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("drops unparseable rank values LAST when truncating, and never reorders when not", () => {
    // A non-finite IP is a parse defect to surface, not a row to silently prefer. It only competes
    // when the view actually truncates — which is the only moment the ordering decides anything.
    // At n >= length the view is the IDENTITY (arrival order preserved, nothing sorted): a view that
    // keeps every row must hand back the corpus untouched, or "full depth" would silently reorder it.
    const rows = [{ ip: NaN, id: "bad" }, { ip: 10, id: "ok" }];
    expect(topNView(rows, "obs", "pit", 1).map((r) => r.id)).toEqual(["ok"]);
    expect(topNView(rows, "obs", "pit", 2).map((r) => r.id)).toEqual(["bad", "ok"]);
  });

  it("reproduces the historical cut as a PREFIX of the committed full-depth captures", () => {
    // The captures arrive already sorted by the observed rule. If that ever stops being true the view
    // still returns the right rows — this pin proves the two agree, so the derived top-100 really is
    // the same selection the old fixtures carried.
    const f = formatByKey("bronzequick")!;
    for (const [role, col] of [["pit", "IP"], ["hit", "PA"]] as const) {
      const lines = readFileSync(abs(captureObsPath(CAPTURE_DIR_2026_07_21, f, role)), "utf8")
        .split(/\r?\n/).filter((l) => l.length);
      const cols = lines[1]!.split("\t");
      const i = cols.indexOf(col);
      const rows = lines.slice(2).map((l) => ({ [role === "pit" ? "ip" : "pa"]: Number(l.split("\t")[i]) }));
      expect(rows.length, role).toBeGreaterThan(LEGACY_TOP_N);
      expect(topNView(rows, "obs", role, LEGACY_TOP_N)).toEqual(rows.slice(0, LEGACY_TOP_N));
    }
  });
});
