// Tournament environment adjustment resolver: a second era-modifier set that MULTIPLIES onto
// the era factors. On by default (HR 1.15 / BB 0.85 / others 1.0) — except the neutral/
// reference pools (default-neutral, oaxaca-league), which default OFF. An explicit field wins.

import { describe, it, expect } from "vitest";
import { resolveTournamentAdjustment, TOURNAMENT_ADJ_DEFAULTS, type Tournament } from "../src/config/tournament.ts";

const mk = (id: string, tournamentAdjustment?: Tournament["tournamentAdjustment"]): Tournament =>
  ({ id, name: id, tournamentAdjustment } as Tournament);

describe("resolveTournamentAdjustment", () => {
  it("defaults ON with HR 1.15 / BB 0.85 / others 1.0 for a normal tournament", () => {
    const a = resolveTournamentAdjustment(mk("silver-spectacular"));
    expect(a).toEqual({ enabled: true, ...TOURNAMENT_ADJ_DEFAULTS });
    expect(a.hr).toBe(1.15);
    expect(a.bb).toBe(0.85);
    expect(a.k).toBe(1);
  });

  it("defaults OFF for the neutral/reference pools", () => {
    expect(resolveTournamentAdjustment(mk("default-neutral")).enabled).toBe(false);
    expect(resolveTournamentAdjustment(mk("oaxaca-league")).enabled).toBe(false);
  });

  it("an explicit field overrides the default", () => {
    const custom = { enabled: true, hr: 1.3, bb: 0.9, k: 1, h: 1.05, gap: 1 };
    expect(resolveTournamentAdjustment(mk("default-neutral", custom))).toEqual(custom); // even a neutral pool
    expect(resolveTournamentAdjustment(mk("silver-spectacular", { ...custom, enabled: false })).enabled).toBe(false);
  });
});
