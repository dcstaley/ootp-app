// Batch 2 — the calibration-audit core. Pins the bias/CI/binning/ranking math and the wOBA
// reconstructions (pitcher proxy from 4 channels; hitter exact from the full breakdown).

import { describe, it, expect } from "vitest";
import {
  pitWobaFromChannels, hitWobaFromRates, channelBias, biasByBin, bias2D, rankDefects, spread,
  PER9_TO_PER600, type AuditRow, type WobaWeights,
} from "../src/eval/cwhit/audit.ts";

const W: WobaWeights = { bb: 0.708, hbp: 0.739, b1: 0.899, xbh: 1.30, hr: 2.05 };
const row = (cid: string, ratings: Record<string, number>, pred: Record<string, number>, obs: Record<string, number>, sample = 1000): AuditRow =>
  ({ cid, name: cid, tier: "t", role: "pit", sample, ratings, pred, obs });

describe("wOBA reconstruction", () => {
  it("pitcher proxy wOBAA moves the right way with each channel", () => {
    const base = pitWobaFromChannels(8, 3, 1, 0.29, W);
    expect(pitWobaFromChannels(10, 3, 1, 0.29, W)).toBeLessThan(base);  // more Ks ⇒ less offense allowed
    expect(pitWobaFromChannels(8, 5, 1, 0.29, W)).toBeGreaterThan(base); // more walks ⇒ more
    expect(pitWobaFromChannels(8, 3, 2, 0.29, W)).toBeGreaterThan(base); // more HR ⇒ more
    expect(pitWobaFromChannels(8, 3, 1, 0.33, W)).toBeGreaterThan(base); // higher BABIP ⇒ more
    expect(base).toBeGreaterThan(0.2); expect(base).toBeLessThan(0.45);  // plausible wOBAA scale
  });
  it("PER9_TO_PER600 bridges the rate units", () => { expect(PER9_TO_PER600).toBeCloseTo(15.5, 1); });
  it("hitter recon lands on a plausible wOBA and rises with power", () => {
    const r = { bbPct: 8, soPct: 20, hr600: 20, babip: 0.30, avg: 0.26, slg: 0.44, tripleXbh: 5 };
    const woba = hitWobaFromRates(r, W);
    expect(woba).toBeGreaterThan(0.28); expect(woba).toBeLessThan(0.42);
    expect(hitWobaFromRates({ ...r, hr600: 40, slg: 0.55 }, W)).toBeGreaterThan(woba);
  });
});

describe("bias + CI", () => {
  it("reports a zero-centered bias with a CI that includes 0 when pred≈obs", () => {
    const rows = [row("a", { con: 50 }, { k9: 8.0 }, { k9: 8.0 }), row("b", { con: 60 }, { k9: 7.0 }, { k9: 7.1 }), row("c", { con: 70 }, { k9: 9.0 }, { k9: 8.9 })];
    const b = channelBias(rows, "k9");
    expect(b.n).toBe(3);
    expect(Math.abs(b.bias)).toBeLessThan(0.1);
    expect(b.ciLo).toBeLessThan(0); expect(b.ciHi).toBeGreaterThan(0);
  });
  it("detects a consistent bias with a CI that excludes 0", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`c${i}`, { con: 50 }, { k9: 8 }, { k9: 7 })); // pred always +1
    const b = channelBias(rows, "k9");
    expect(b.bias).toBeCloseTo(1, 6);
    expect(b.ciLo).toBeGreaterThan(0); // significant
  });
});

describe("binning + ranking", () => {
  const rows = [
    row("lo1", { stu: 40 }, { k9: 6 }, { k9: 6 }), row("lo2", { stu: 45 }, { k9: 6.2 }, { k9: 6.1 }),
    row("hi1", { stu: 80 }, { k9: 11 }, { k9: 9 }), row("hi2", { stu: 85 }, { k9: 12 }, { k9: 10 }), // high-stu over-predicts K
  ];
  it("biasByBin isolates the high-stu over-prediction", () => {
    const bins = biasByBin(rows, "k9", "stu", [60]);
    const hi = bins.find((b) => b.label.startsWith("≥"))!;
    const lo = bins.find((b) => b.label.startsWith("<"))!;
    expect(hi.bias).toBeGreaterThan(1.5);
    expect(Math.abs(lo.bias)).toBeLessThan(0.2);
  });
  it("bias2D produces a con×stu grid", () => {
    const g = bias2D(rows, "k9", "stu", [60], "con", [60]);
    expect(g.length).toBe(4); // 2×2
    expect(g.every((c) => typeof c.stat.bias === "number")).toBe(true);
  });
  it("rankDefects orders by |effect|×prevalence and flags significance", () => {
    const ranked = rankDefects([
      { key: "small", channel: "bb9", biasMwoba: 1, ciLoMwoba: 0.5, ciHiMwoba: 1.5, n: 10, prevalence: 0.1 },
      { key: "big", channel: "k9", biasMwoba: 7, ciLoMwoba: 5, ciHiMwoba: 9, n: 40, prevalence: 0.4 },
      { key: "noise", channel: "hr9", biasMwoba: 3, ciLoMwoba: -1, ciHiMwoba: 7, n: 5, prevalence: 0.05 },
    ]);
    expect(ranked[0]!.key).toBe("big");
    expect(ranked.find((d) => d.key === "noise")!.significant).toBe(false);
  });
  it("spread computes population SD for the elite-tail check", () => {
    expect(spread([row("a", {}, {}, { woba: 0.30 }), row("b", {}, {}, { woba: 0.32 })], (r) => r.obs.woba!)).toBeCloseTo(0.01, 3);
  });
});
