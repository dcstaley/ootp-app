// Batch-1 item 1 — the deploy-time vertex gate. A fitted quad that turns over WITHIN its own fit
// domain is a corrupt SHAPE (a better rating scores worse over that band); the cap/tangent extension
// keep it safe to EVALUATE but must never let it deploy silently. These tests pin the detector: an
// in-domain vertex is flagged, an out-of-domain / ~linear quad is not, and the H rating quad counts.

import { describe, it, expect } from "vitest";
import {
  inDomainVertex, inDomainVertexH, formVertexOffenders,
  type FittedEvent, type FittedH, type EventForm,
} from "../src/model/curves.ts";

const ev = (beta: number[], uMin: number, uMax: number): FittedEvent =>
  ({ beta, mu: 0, sd: 1, curve: { kind: "rawpoly", degree: 2 }, uMin, uMax });
const log = (): FittedEvent => ({ beta: [0, 1], mu: 0, sd: 1, curve: { kind: "log" } });
// H with a rawpoly-2 rating quad (coeffs at beta[1],beta[2]) + a trailing log-BIP term.
const hQuad = (b1: number, b2: number, uMin: number, uMax: number): FittedH =>
  ({ beta: [0, b1, b2, 0.5], rating: { curve: { kind: "rawpoly", degree: 2 }, mu: 0, sd: 1, uMin, uMax },
     bip: { curve: { kind: "log" }, mu: 0, sd: 1 } });
const hLog = (): FittedH =>
  ({ beta: [0, 1, 0.5], rating: { curve: { kind: "log" }, mu: 0, sd: 1 }, bip: { curve: { kind: "log" }, mu: 0, sd: 1 } });

describe("deploy-time vertex gate — detection", () => {
  it("flags a quad whose vertex is strictly interior to the fit domain", () => {
    // f(u) = u − 0.25u² → vertex at u = −1/(2·−0.25) = 2, inside [-3,3]
    expect(inDomainVertex(ev([0, 1, -0.25], -3, 3))).toBeCloseTo(2, 9);
  });
  it("does NOT flag a quad whose vertex sits outside the fit domain", () => {
    // same vertex u=2, but the data only spans [-3, 1] → monotone over the domain
    expect(inDomainVertex(ev([0, 1, -0.25], -3, 1))).toBeNull();
  });
  it("does NOT flag a ~linear quad (b2 ≈ 0)", () => {
    expect(inDomainVertex(ev([0, 1, 1e-15], -3, 3))).toBeNull();
  });
  it("does NOT flag a non-rawpoly-2 curve, or one missing its fit domain", () => {
    expect(inDomainVertex(log())).toBeNull();
    expect(inDomainVertex({ beta: [0, 1, -0.25], mu: 0, sd: 1, curve: { kind: "rawpoly", degree: 2 } })).toBeNull();
  });
  it("applies the same test to the H event's rating quad", () => {
    expect(inDomainVertexH(hQuad(1, -0.25, -3, 3))).toBeCloseTo(2, 9); // interior
    expect(inDomainVertexH(hQuad(1, -0.25, -3, 1))).toBeNull();        // out-of-domain
    expect(inDomainVertexH(hLog())).toBeNull();                        // log rating ⇒ nothing to flag
  });
});

describe("deploy-time vertex gate — form scan", () => {
  const cleanForm = (): EventForm => ({
    hit: { bb: log(), k: log(), hr: ev([0, 1, -0.25], -3, 1), xbh: log(), h: hLog() },
    pit: { bb: log(), k: ev([0, 1, -0.25], -3, 1), hr: ev([0, 1, -0.25], -3, 1), h: hLog() },
  });

  it("returns no offenders for a gate-clean form (every quad monotone in-domain)", () => {
    expect(formVertexOffenders(cleanForm())).toEqual([]);
  });

  it("names each channel whose quad turns over in-domain, with its vertex", () => {
    const bad = cleanForm();
    bad.pit.k = ev([0, 1, -0.25], -3, 3); // now interior
    bad.hit.hr = ev([0, 1, -0.25], -3, 3);
    bad.pit.h = hQuad(1, -0.25, -3, 3);
    const off = formVertexOffenders(bad);
    const channels = off.map((o) => o.channel).sort();
    expect(channels).toEqual(["hit.hr", "pit.h", "pit.k"]);
    for (const o of off) expect(o.vertexZ).toBeCloseTo(2, 6);
  });
});
