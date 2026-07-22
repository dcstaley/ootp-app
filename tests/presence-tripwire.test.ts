// THE STANDING PRESENCE TRIPWIRE (drift doctrine) — pins.
//
// WHAT IT PROTECTS: the shipped pitcher K-spread ramp is fitted AT p = PRESENCE_P and its
// sensitivity legs cover only 0.25-0.35. A ramp fitted at one p can never be RESCALED to another —
// the gap is not monotone in p — only RE-DERIVED. So realized presence drifting out of that band is
// not a small error, it is the ramp being evaluated outside its evidence.
//
// The drift doctrine's claim is that fixed values going stale is the NULL, not a defect, and the
// defence is detectability rather than denial. That makes the tripwire itself the load-bearing part,
// which is why it is pinned in three halves:
//   1) the measurement (conditional, not raw — and the exact decomposition that relates them),
//   2) the verdict (band edges INCLUSIVE, thin never a pass),
//   3) a SOURCE SCAN proving it is actually WIRED into the one sample builder. A behavioural test
//      of that would need capture fixtures on disk; the failure mode being trapped is the call
//      going MISSING, not a number changing, which is exactly when a source scan is the right pin.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  conditionalPresence, presenceTripwire, PRESENCE_P, PRESENCE_BAND, PRESENCE_MIN_USAGE,
  type PresenceRow,
} from "../src/data/variants.ts";

/** Enough usage to clear the thinness bar, split into the shape a caller asks about. */
const rows = (opts: { eligBase: number; eligV5: number; ineligible: number }): PresenceRow[] => [
  { usage: opts.eligBase, variant: false, eligible: true },
  { usage: opts.eligV5, variant: true, eligible: true },
  { usage: opts.ineligible, variant: false, eligible: false },
];

describe("conditionalPresence — the quantity the pool-leg mixture is parameterised by", () => {
  it("divides v5 usage by ELIGIBLE-CLASS usage, not by all usage", () => {
    // 30% of eligible usage is v5, but only 15% of ALL usage, because half the play sits in cards
    // that CANNOT have a variant. Reading the raw share as p is the error this function exists to
    // prevent — it would understate presence by a factor of two here.
    const r = conditionalPresence(rows({ eligBase: 7000, eligV5: 3000, ineligible: 10000 }));
    expect(r.conditionalP).toBeCloseTo(0.30, 12);
    expect(r.rawShare).toBeCloseTo(0.15, 12);
  });
  it("satisfies the decomposition raw = eligible-share x conditional EXACTLY", () => {
    // Exact because every v5 row belongs to an eligible card. An inexact result would mean the
    // eligibility predicate and the variant flag disagree about some row.
    for (const o of [
      { eligBase: 7000, eligV5: 3000, ineligible: 10000 },
      { eligBase: 12345, eligV5: 987, ineligible: 54321 },
      { eligBase: 1, eligV5: 99999, ineligible: 7 },
    ]) {
      const r = conditionalPresence(rows(o));
      expect(Math.abs(r.rawShare - r.eligibleShare * r.conditionalP)).toBeLessThan(1e-12);
    }
  });
  it("ignores zero and non-finite usage rather than letting it poison the totals", () => {
    const r = conditionalPresence([
      ...rows({ eligBase: 7000, eligV5: 3000, ineligible: 10000 }),
      { usage: 0, variant: true, eligible: true },
      { usage: NaN, variant: true, eligible: true },
      { usage: -5, variant: false, eligible: true },
    ]);
    expect(r.rows).toBe(3);
    expect(r.conditionalP).toBeCloseTo(0.30, 12);
  });
  it("returns NaN — not 0 — when nothing eligible played", () => {
    // 0 would read as "no variants present", a real finding. NaN reads as "unanswerable", which is
    // what it is, and the tripwire turns it into 'insufficient data'.
    const r = conditionalPresence([{ usage: 50000, variant: false, eligible: false }]);
    expect(r.conditionalP).toBeNaN();
  });
});

describe("presenceTripwire — silent in band, loud outside, never a verdict when thin", () => {
  const at = (p: number, elig = 100000) =>
    presenceTripwire(conditionalPresence([
      { usage: elig * (1 - p), variant: false, eligible: true },
      { usage: elig * p, variant: true, eligible: true },
    ]));

  it("passes at the shipped p itself", () => {
    const t = at(PRESENCE_P);
    expect(t.verdict).toBe("in-band");
    expect(t.ok).toBe(true);
  });
  it("BAND EDGES ARE INCLUSIVE — 0.25 and 0.35 pass, because they are the sensitivity legs", () => {
    // The gates were re-checked AT 0.25 and 0.35, so the evidence covers those points. An exclusive
    // edge would fire the tripwire on exactly the values the ramp is known to survive.
    expect(at(PRESENCE_BAND.lo).verdict).toBe("in-band");
    expect(at(PRESENCE_BAND.hi).verdict).toBe("in-band");
  });
  it("FIRES outside the band, in both directions, and says what to do about it", () => {
    for (const p of [0.20, 0.24, 0.36, 0.45]) {
      const t = at(p);
      expect(t.verdict).toBe("OUT-OF-BAND");
      expect(t.ok).toBe(false);
      expect(t.message).toMatch(/NEXT REFIT EVENT/);
      // The one thing a reader must not conclude is that the ramp can be adjusted to the new p.
      expect(t.message).toMatch(/RE-DERIVED/);
    }
  });
  it("a THIN reading is 'insufficient data' and is NEVER reported as a breach", () => {
    // A tripwire that cried wolf on thin data would be turned off, which is how tripwires die.
    const t = at(0.9, PRESENCE_MIN_USAGE - 1);
    expect(t.verdict).toBe("insufficient data");
    expect(t.message).toMatch(/not a pass/);
  });
  it("thin data does not silently PASS either — the message refuses the pass explicitly", () => {
    const t = at(PRESENCE_P, PRESENCE_MIN_USAGE - 1);
    expect(t.verdict).toBe("insufficient data");
    expect(t.verdict).not.toBe("in-band");
  });
});

describe("SOURCE SCAN — the tripwire is wired into the ONE sample builder", () => {
  const src = readFileSync("src/eval/cwhit/sample.ts", "utf8");
  it("buildCwhitSample computes the reading and runs the tripwire", () => {
    expect(src).toMatch(/conditionalPresence\(/);
    expect(src).toMatch(/presenceTripwire\(/);
  });
  it("exposes the reading on the result even when in band (so tools can print a silent pass)", () => {
    expect(src).toMatch(/presence,\s*presenceTrip\s*\}/);
  });
  it("pushes a notice when the verdict is anything other than in-band", () => {
    // Including 'insufficient data' — a tripwire that has quietly stopped seeing data looks
    // identical to one that is passing, unless it says so.
    expect(src).toMatch(/verdict !== "in-band"\) notices\.push/);
  });
});
