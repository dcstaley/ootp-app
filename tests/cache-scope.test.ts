// AN UNSAVED DRAFT MUST NOT SEED PROCESS-GLOBAL STATE (item-B carve-out, 2026-07-21).
//
// `/api/position-metrics` scores a possibly-unsaved editor draft. That call reaches
// `referenceFieldStats` and `leagueExposureBaseline`, both process-global caches keyed on
// `${activeModelId}|${catalogSource}` with no tournament in the key — so on a cold cache the first
// thing scored wins, and a draft could be that thing. Every later tournament would then read a
// reference field seeded from a configuration that exists in no saved state.
//
// Two pins, because the defect has two halves:
//   1. the SCOPE ITSELF behaves (nests, unwinds, survives a throw) — a unit test;
//   2. the scope is actually APPLIED at the three sites that matter — a source scan, for the same
//      reason the FIELD_N pin is a source scan: a behavioural test would need the server booted,
//      and the failure mode here is a guard silently going missing rather than a value changing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inEphemeralScope, mayCache, ephemeralDepth } from "../src/server/cache-scope.ts";

describe("ephemeral cache scope", () => {
  it("suppresses writes only inside the scope, and nests", () => {
    expect(mayCache()).toBe(true);
    inEphemeralScope(() => {
      expect(mayCache()).toBe(false);
      inEphemeralScope(() => expect(mayCache()).toBe(false));
      // The inner scope exiting must NOT re-enable caching while the outer one is open — this is
      // exactly what a boolean would get wrong, and why the implementation counts.
      expect(mayCache()).toBe(false);
    });
    expect(mayCache()).toBe(true);
    expect(ephemeralDepth()).toBe(0);
  });

  it("unwinds when the scoped computation throws", () => {
    expect(() => inEphemeralScope(() => { throw new Error("boom"); })).toThrow("boom");
    expect(mayCache(), "a throw inside the scope must not leave caching disabled forever").toBe(true);
    expect(ephemeralDepth()).toBe(0);
  });

  it("returns the scoped computation's value", () => {
    expect(inEphemeralScope(() => 42)).toBe(42);
  });

  it("is APPLIED at both process-global caches and at the draft endpoint", () => {
    const src = readFileSync("src/server/server.ts", "utf8");
    // Every write to these caches must be guarded. Matching the assignment and requiring the guard
    // on the same line keeps the pin honest without parsing TypeScript.
    for (const cache of ["refFieldCache", "leagueBaselineCache"]) {
      // `= {` only: the `= null` resets in invalidateDerivedCaches are clears, not seeds.
      const writes = src.split("\n").filter((l) => new RegExp(String.raw`\b${cache}\s*=\s*\{`).test(l));
      expect(writes.length, `${cache}: expected exactly one guarded write site`).toBe(1);
      expect(writes[0], `${cache} is written WITHOUT a mayCache() guard — an unsaved draft can seed it`)
        .toMatch(/if \(mayCache\(\)\)/);
    }
    // And the draft path must actually open a scope.
    expect(src, "/api/position-metrics must score its draft inside inEphemeralScope")
      .toMatch(/inEphemeralScope\(\(\) => positionPoolStats\(t, scoreTournament\(t\)\)\)/);
  });
});
