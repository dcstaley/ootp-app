// 2026-07-21 vertex-pin monotone fallback (bake-off candidate C — evidence
// fixtures/pithr-form-bakeoff-run-2026-07-21.txt). The production fit path (fitHitForm/fitPitForm
// with a `pins` collector, as server.saveTrainedModel calls them) refits any degree-2 rawpoly
// channel whose unconstrained vertex lands INSIDE the fit domain, pinning the vertex at the
// domain max. These tests pin:
//   (a) constraint INACTIVE ⇒ coefficients bit-identical to the unconstrained fit (synthetic + real);
//   (b) a synthetic in-domain vertex ⇒ the channel comes back pinned, monotone over the domain,
//       inDomainVertex passes, and the pins record (what the artifact stores as `vertexPinned`)
//       names the channel with pinZ = the domain max;
//   (c) the real [2042,2043] window through the trainer fit path reproduces the bake-off's C fit
//       on pit.hr (vertex at domain max ≈2.652, beta ≈ [15.0615, −1.6730, +0.3154]).

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import {
  fitHitForm, fitPitForm, PARETO_PIT, RAWPOLY_HIT, type VertexPin,
} from "../src/training/forms.ts";
import { inDomainVertex, inDomainVertexH, rateRaw } from "../src/model/curves.ts";

// ── synthetic observations (exact functional data — deterministic fits) ────────
const hit0 = { PA: 0, AB: 0, H: 0, b1: 0, b2: 0, b3: 0, HR: 0, BB: 0, IBB: 0, HP: 0, SH: 0, SF: 0, K: 0, GIDP: 0 };
const pitch0 = { BF: 0, IP: 0, AB: 0, b1: 0, b2: 0, b3: 0, HR: 0, BB: 0, IBB: 0, K: 0, HP: 0, SH: 0, SF: 0 };
const hitR0 = { eye: 50, pow: 50, kRat: 50, babip: 50, gap: 50, speed: 50, steal: 50, run: 50 };

function pitObsAt(i: number, hrOf: (hrr: number) => number): TrainObs {
  const hrr = 50 + i * 2.5;                    // 50 … 197.5
  const stu = 80 + (i % 10) * 8;               // 80 … 152 (varies independently of hrr)
  const con = 60 + (i % 12) * 10;              // 60 … 170
  const pbabip = 60 + ((i * 7) % 40) * 2.5;    // 60 … 157.5
  const K = 40 + 0.3 * stu + 0.002 * stu * stu; // exact convex quad, vertex at stu = −75 (out of domain)
  const BB = 70 - 0.25 * con + 20;              // decreasing (log BB channel — no vertex possible)
  const H1 = 60 + 0.8 * pbabip + 0.002 * pbabip * pbabip; // convex increasing, vertex at pbabip = −200
  return {
    key: `p${i}|B|R`, cid: `p${i}`, variant: false, side: "R", name: `P${i}`, pos: "SP", bats: 1, throws: 1,
    ratings: { hit: { ...hitR0 }, pitch: { con, stu, pbabip, hrr } },
    hit: { ...hit0 },
    pitch: { ...pitch0, BF: 600, IP: 150, AB: 550, b1: H1, HR: hrOf(hrr), BB, K },
    sources: [{ league: "SYN", year: 2042, pa: 0, bf: 600 }],
  };
}
// ∪-shaped HR (the real pit.hr failure mode): falls with pHR rating, turns UP at 160 — vertex
// strictly inside the observed [50, 197.5] rating span.
const pitObsTurnover = Array.from({ length: 60 }, (_, i) => pitObsAt(i, (hrr) => 5 + 0.001 * (hrr - 160) ** 2));
// Clean convex-monotone HR: vertex at rating 250, outside the span — the constraint stays inactive.
const pitObsClean = Array.from({ length: 60 }, (_, i) => pitObsAt(i, (hrr) => 30 - 0.1 * hrr + 0.0002 * hrr * hrr));

function hitObsAt(i: number, hrOf: (pow: number) => number): TrainObs {
  const pow = 50 + i * 2.5;                    // 50 … 197.5
  const eye = 40 + (i % 10) * 10, kRat = 50 + (i % 8) * 12;
  const babip = 60 + ((i * 3) % 40) * 2, gap = 50 + ((i * 11) % 50) * 2;
  const HR = hrOf(pow), b1 = 90 + 0.2 * babip, b2 = 25, b3 = 5;
  return {
    key: `h${i}|B|R`, cid: `h${i}`, variant: false, side: "R", name: `H${i}`, pos: "CF", bats: 1, throws: 1,
    ratings: { hit: { eye, pow, kRat, babip, gap, speed: 50, steal: 50, run: 50 }, pitch: { con: 50, stu: 50, pbabip: 50, hrr: 50 } },
    hit: { ...hit0, PA: 600, AB: 540, H: b1 + b2 + b3 + HR, b1, b2, b3, HR, BB: 20 + 0.3 * eye, K: 150 - 0.4 * kRat },
    pitch: { ...pitch0 },
    sources: [{ league: "SYN", year: 2042, pa: 600, bf: 0 }],
  };
}
// ∩-shaped hitter HR (increasing channel turning over): peaks at POW 150 inside [50, 197.5].
const hitObsTurnover = Array.from({ length: 60 }, (_, i) => hitObsAt(i, (pow) => 40 - 0.002 * (pow - 150) ** 2));

describe("vertex-pin fallback — synthetic", () => {
  it("(a) constraint inactive ⇒ bit-identical to the unconstrained fit, no pins recorded", () => {
    const base = fitPitForm(PARETO_PIT, pitObsClean);
    expect(inDomainVertex(base.hr)).toBeNull(); // precondition: the synthetic quad is clean
    const pins: VertexPin[] = [];
    const pinned = fitPitForm(PARETO_PIT, pitObsClean, 0.75, pins);
    expect(pins).toEqual([]);
    expect(JSON.stringify(pinned)).toBe(JSON.stringify(base)); // every channel bit-identical
  });

  it("(b) pitcher: in-domain hr vertex ⇒ pinned at domain max, monotone, gate passes, pin recorded", () => {
    const base = fitPitForm(PARETO_PIT, pitObsTurnover);
    expect(inDomainVertex(base.hr)).not.toBeNull(); // the unconstrained quad genuinely turns over
    const pins: VertexPin[] = [];
    const fit = fitPitForm(PARETO_PIT, pitObsTurnover, 0.75, pins);
    const rec = pins.find((p) => p.channel === "pit.hr");
    expect(rec).toBeDefined();
    expect(rec!.pinZ).toBeCloseTo(fit.hr.uMax!, 12);            // pinned AT the domain max
    expect(-fit.hr.beta[1]! / (2 * fit.hr.beta[2]!)).toBeCloseTo(fit.hr.uMax!, 8); // vertex = uMax exactly
    // the whole pinned form is gate-clean (inDomainVertex passes on every channel)
    expect(inDomainVertex(fit.hr)).toBeNull();
    expect(inDomainVertex(fit.k)).toBeNull();
    expect(inDomainVertex(fit.bb)).toBeNull();
    expect(inDomainVertexH(fit.h)).toBeNull();
    // monotone (decreasing) over the observed rating domain — the raw SHAPE, not the cap
    let prev = Infinity;
    for (let r = 50; r <= 197.5; r += 2.5) { const cur = rateRaw(fit.hr, r); expect(cur).toBeLessThanOrEqual(prev + 1e-9); prev = cur; }
  });

  it("(b) hitter: generic across roles/directions — an increasing hit.hr quad pins too", () => {
    const base = fitHitForm(RAWPOLY_HIT, hitObsTurnover);
    expect(inDomainVertex(base.hr)).not.toBeNull();
    const pins: VertexPin[] = [];
    const fit = fitHitForm(RAWPOLY_HIT, hitObsTurnover, 0.75, pins);
    expect(pins.map((p) => p.channel)).toEqual(["hit.hr"]); // the only quad channel in RAWPOLY_HIT
    expect(inDomainVertex(fit.hr)).toBeNull();
    // monotone NON-DECREASING (increasing channel: the pin must preserve the direction)
    let prev = -Infinity;
    for (let r = 50; r <= 197.5; r += 2.5) { const cur = rateRaw(fit.hr, r); expect(cur).toBeGreaterThanOrEqual(prev - 1e-9); prev = cur; }
  });
});

// ── real training windows (skipped when the gitignored data isn't present) ─────
const ROOT = "League Files";
const MINBF = 1000;

describe.skipIf(!existsSync(ROOT))("vertex-pin fallback — real windows (trainer fit path)", () => {
  it("(a) [2041,2042]: vertex outside the domain ⇒ pins empty, fit bit-identical", () => {
    const qual = loadWindow(ROOT, [2041, 2042]).observations.filter((o) => PITCHER.qualifies(o, MINBF));
    const base = fitPitForm(PARETO_PIT, qual);
    expect(inDomainVertex(base.hr)).toBeNull(); // the bake-off's verified inactive window
    const pins: VertexPin[] = [];
    const pinned = fitPitForm(PARETO_PIT, qual, 0.75, pins);
    expect(pins).toEqual([]);
    expect(JSON.stringify(pinned)).toBe(JSON.stringify(base));
  });

  it("(c) [2042,2043]: pit.hr pins at domain max ≈2.652 with the bake-off C coefficients", () => {
    const obs = loadWindow(ROOT, [2042, 2043]).observations;
    const pitQual = obs.filter((o) => PITCHER.qualifies(o, MINBF));
    const hitQual = obs.filter((o) => HITTER.qualifies(o, MINBF));
    const pins: VertexPin[] = [];
    // exactly the saveTrainedModel call shape (deployed forms, fitExp default, one shared collector)
    const hit = fitHitForm(RAWPOLY_HIT, hitQual, 0.75, pins);
    const pit = fitPitForm(PARETO_PIT, pitQual, 0.75, pins);
    const rec = pins.find((p) => p.channel === "pit.hr");
    expect(rec).toBeDefined();
    expect(rec!.pinZ).toBeCloseTo(2.652, 2);
    // the bake-off's candidate-C fit (fixtures/pithr-form-bakeoff-run-2026-07-21.txt line "C (pinned quad …)")
    expect(pit.hr.beta[0]).toBeCloseTo(15.0615, 3);
    expect(pit.hr.beta[1]).toBeCloseTo(-1.6730, 3);
    expect(pit.hr.beta[2]).toBeCloseTo(0.3154, 3);
    expect(-pit.hr.beta[1]! / (2 * pit.hr.beta[2]!)).toBeCloseTo(pit.hr.uMax!, 8);
    expect(inDomainVertex(pit.hr)).toBeNull();
    // and nothing else pinned on this window (matches the bake-off run: no other offenders noted)
    expect(pins.map((p) => p.channel)).toEqual(["pit.hr"]);
    expect(inDomainVertex(hit.hr)).toBeNull();
  });
});
