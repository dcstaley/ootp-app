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
import { EXPOSURE_N } from "../src/eval/exposure.ts";

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

  it("no DEFAULTED LITERAL silently stands in for a cohort size", () => {
    // THE BLIND SPOT THE ITEM-B AUDIT FOUND. The declaration scan above matches `const X =` only, so
    // `opts.fieldN ?? 50` in src/eval/consistency.ts was invisible to it — a second copy of the
    // cohort size living as a DEFAULT rather than a declaration. Same defect class as the one ruling
    // (d) closed, wearing different syntax. That call site now defaults to the imported constant.
    //
    // NOT covered here on purpose: `topX ?? 100`. The optimizer-pool size has NO canonical constant
    // to point at, which is itself an item-B finding rather than something a pin can fix; adding a
    // constant for it is an arbitration outcome, not a test change.
    const bare = /\b(fieldN|anchorN)\s*(\?\?|=)\s*\d+/;
    const offenders: string[] = [];
    for (const f of tsFiles("src")) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (bare.test(line)) offenders.push(`${f.replace(/\\/g, "/")}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, "a cohort size must reference FIELD_N/ANCHOR_N, never a bare number").toEqual([]);
  });

  it("EXPOSURE_N is declared once, and outside the server-listening file", () => {
    // Fable ruling (r). It was a module-local in src/server/server.ts, which calls server.listen()
    // at import -- so the B2 sizing tool had to MIRROR it, along with exposureFieldMembers and
    // realizedSplitsOf. A mirrored constant drifts from production silently, and the tool measuring
    // production is the last thing that would notice.
    const sites = declSites("EXPOSURE_N");
    expect(sites.map((x) => x.split("\\").join("/"))).toEqual(["src/eval/exposure.ts"]);
    expect(EXPOSURE_N).toBe(100);
    // 100 is not a free tuning choice: B2 measured the variant delta on this baseline spanning
    // -513% to +104% of its N=100 value over N in {25..300}, CHANGING SIGN. {100,150,200} is the
    // stable plateau and the shipped value sits inside it.
    const src = readFileSync("src/server/server.ts", "utf8");
    expect(/function\s+(exposureFieldMembers|realizedSplitsOf)/.test(src),
      "these moved to src/eval/exposure.ts; a copy here is the defect ruling (r) closed").toBe(false);
  });

  it("ANCHOR_N is a SEPARATE constant that merely shares the value", () => {
    // Pinned so nobody 'tidies' them into one. They serve different purposes (field cohort vs
    // calibration anchor cohort), and the item-B audit found the shared 50 is COINCIDENTAL: no
    // quantity compares a FIELD_N cohort against an ANCHOR_N one, and moving FIELD_N would
    // un-match the frame gap's legs for every already-trained model (it is frozen into
    // trainingMeans), while ANCHOR_N is a contained scale knob.
    const sites = declSites("ANCHOR_N");
    expect(sites.map((s) => s.replace(/\\/g, "/"))).toEqual(["src/scoring-core/calibrate.ts"]);
    expect(ANCHOR_N).toBe(50);
  });
});
