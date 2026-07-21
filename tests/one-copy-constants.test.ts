// ONE COPY, ENFORCED AT THE SOURCE LEVEL (Fable ruling (d), 2026-07-21).
//
// FIELD_N was DEFINED TWICE — `src/server/server.ts` and `src/eval/cwhit/sample.ts` — at the same
// value, with nothing holding them together. Nobody would have noticed a divergence: production
// would have used one field size and every eval tool would have measured it at the other, and every
// cross-check between them would still have looked internally consistent.
//
// A value-equality assertion cannot catch that class of defect, because the moment someone writes a
// second `const FIELD_N = 50` the two values are equal — that IS the bug, in its harmless-looking
// initial state. So this pin is a SOURCE scan: the definition must exist exactly once.
//
// This is deliberately about DEFINITION SITES, not imports or re-exports. `export { FIELD_N }` in
// sample.ts is fine and intended (its ~50 consumers keep their import path); a fresh
// `const FIELD_N = …` anywhere is not.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIELD_N } from "../src/scoring-core/index.ts";
import { FIELD_N as FIELD_N_EVAL } from "../src/eval/cwhit/sample.ts";
import { ANCHOR_N } from "../src/scoring-core/calibrate.ts";

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** `const X =` / `let X =` / `var X =`, with or without `export` — a DECLARATION, not an import. */
const declSites = (name: string) => {
  const re = new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+${name}\s*(?::[^=]+)?=`, "m");
  return tsFiles("src").filter((f) => re.test(readFileSync(f, "utf8")));
};

describe("one-copy constants", () => {
  it("FIELD_N is declared in exactly one place", () => {
    const sites = declSites("FIELD_N");
    expect(sites, `FIELD_N declared in ${sites.length} files: ${sites.join(", ")}`).toHaveLength(1);
    expect(sites[0]!.replace(/\\/g, "/")).toBe("src/scoring-core/pool-stats.ts");
  });

  it("every consumer resolves to that one value", () => {
    // Cheap and non-vacuous: if a second declaration ever shadows the import in sample.ts, the
    // source scan above fails first, and this catches a re-export wired to something else.
    expect(FIELD_N_EVAL).toBe(FIELD_N);
    expect(FIELD_N).toBe(50);
  });

  it("ANCHOR_N is a SEPARATE constant that merely shares the value", () => {
    // Pinned so nobody 'tidies' them into one. They serve different purposes (field cohort vs
    // calibration anchor cohort); whether the shared value is intentional is the item-B question.
    const sites = declSites("ANCHOR_N");
    expect(sites.map((s) => s.replace(/\\/g, "/"))).toEqual(["src/scoring-core/calibrate.ts"]);
    expect(ANCHOR_N).toBe(50);
  });
});
