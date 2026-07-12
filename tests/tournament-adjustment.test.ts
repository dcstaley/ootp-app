// Tournament environment adjustment resolver: a second era-modifier set that MULTIPLIES onto
// the era factors. OFF unless a tournament explicitly enables it (the old blanket
// HR 1.15 / BB 0.85 on-by-default was retired 2026-07-12 — real-tournament validation showed
// the bias it targeted is role-asymmetric, which a symmetric multiplier can't express).
// An explicit field always wins.

import { describe, it, expect } from "vitest";
import { resolveTournamentAdjustment, TOURNAMENT_ADJ_DEFAULTS, type Tournament } from "../src/config/tournament.ts";

const mk = (id: string, tournamentAdjustment?: Tournament["tournamentAdjustment"]): Tournament =>
  ({ id, name: id, tournamentAdjustment } as Tournament);

describe("resolveTournamentAdjustment", () => {
  it("defaults OFF for any tournament without an explicit field", () => {
    const a = resolveTournamentAdjustment(mk("silver-spectacular"));
    expect(a.enabled).toBe(false);
    // the knob's seed values are still carried so enabling in the editor starts from them
    expect(a.hr).toBe(TOURNAMENT_ADJ_DEFAULTS.hr);
    expect(a.bb).toBe(TOURNAMENT_ADJ_DEFAULTS.bb);
    expect(resolveTournamentAdjustment(mk("default-neutral")).enabled).toBe(false);
    expect(resolveTournamentAdjustment(mk("oaxaca-league")).enabled).toBe(false);
  });

  it("an explicit field overrides the default", () => {
    const custom = { enabled: true, hr: 1.3, bb: 0.9, k: 1, h: 1.05, gap: 1 };
    expect(resolveTournamentAdjustment(mk("default-neutral", custom))).toEqual(custom);
    expect(resolveTournamentAdjustment(mk("silver-spectacular", { ...custom, enabled: false })).enabled).toBe(false);
  });
});
