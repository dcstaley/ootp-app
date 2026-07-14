// Catalog-import quad-spike tripwire: warns when an incoming card pushes a cap-risk quad channel out of the
// fitted domain or near its vertex (the non-stationary-meta guard). See src/eval/catalog-census.ts.
import { describe, it, expect } from "vitest";
import { catalogQuadCensus } from "../src/eval/catalog-census.ts";
import type { EventForm, FittedEvent, FittedHit, FittedPit } from "../src/model/curves.ts";

// A rawpoly-2 event on the raw rating: mu 100, sd 20, domain u∈[−2,2] → rating [60,140]; ∩ vertex at u=3 (=160).
const quad = (): FittedEvent => ({ beta: [20, 3, -0.5], mu: 100, sd: 20, curve: { kind: "rawpoly", degree: 2 }, uMin: -2, uMax: 2 });
const log = (): FittedEvent => ({ beta: [0, 1], mu: 0, sd: 1, curve: { kind: "log" } });
const ev = (): EventForm => ({
  hit: { bb: log(), k: log(), hr: quad(), xbh: log(), h: {} as any } as FittedHit,
  pit: { bb: log(), k: log(), hr: quad(), h: {} as any } as FittedPit,
});

describe("catalog quad-spike tripwire", () => {
  it("all cards inside the fitted domain ⇒ no warnings", () => {
    const cards = [{ "Power vR": 120 }, { "Power vR": 140 }, { "Stuff vR": 90 }, { "pHR vR": 100 }];
    const r = catalogQuadCensus(cards, ev());
    expect(r.warnings).toHaveLength(0);
  });

  it("a card beyond the fitted domain max ⇒ out-of-domain warning", () => {
    const r = catalogQuadCensus([{ "Power vR": 150 }], ev()); // domainMax 140
    expect(r.warnings.some((w) => w.includes("beyond the fitted domain"))).toBe(true);
    expect(r.channels.find((c) => c.label.includes("HR ← Power"))!.outOfDomain).toBe(1);
  });

  it("a card within the margin of the vertex ⇒ near-vertex warning", () => {
    const r = catalogQuadCensus([{ "Power vR": 150 }], ev(), 15); // vertex 160, 150 > 160−15
    expect(r.warnings.some((w) => w.includes("within 15 of the vertex"))).toBe(true);
  });

  it("log channels are not policed (no vertex) ⇒ no false warning from Stuff/pHR", () => {
    const evLogHR = ev(); evLogHR.pit.hr = log();
    const r = catalogQuadCensus([{ "pHR vR": 300 }], evLogHR);
    expect(r.warnings).toHaveLength(0);
  });
});
