// M2a/M2b — catalog import, eligibility evaluation, pool construction, and the
// tournament → eligible pool → calibrate chain. Committable: uses the tracked
// pt_card_list.csv + the _synthetic coeffs fixture.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible, buildEligiblePool } from "../src/config/eligibility.ts";
import { calibrate, computeDerived, TARGET_WOBA, type Coeffs } from "../src/scoring-core/index.ts";
import type { Tournament } from "../src/config/tournament.ts";

const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));
const syntheticCoeffs = (JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")) as { coeffs: Coeffs }).coeffs;

const makeTournament = (over: Partial<Tournament>): Tournament => ({
  id: "t", name: "t",
  card_value_min: null, card_value_max: null, total_cap: null,
  roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
  variants_allowed: true, max_variants_on_roster: 5,
  eraId: "neutral", parkId: "neutral",
  softcaps: {} as Tournament["softcaps"],
  eligibility: { mode: "ALL", rules: [] },
  ...over,
});

describe("catalog import", () => {
  it("parses pt_card_list.csv into cards with named columns", () => {
    expect(catalog.cards.length).toBe(3376);
    expect(catalog.columns).toContain("Card Value");
    expect(catalog.cards[0]!["Card ID"]).toBeTruthy();
  });
});

describe("rowEligible", () => {
  const card = { "Card Value": "85", "Variant": "", "//Card Title": "Hardware Heroes LF Ted Williams", "Position": "7" } as Record<string, string>;

  it("passes with no tournament or empty rules", () => {
    expect(rowEligible(card, null)).toBe(true);
    expect(rowEligible(card, makeTournament({}))).toBe(true);
  });

  it("gates variants when variants_allowed is false", () => {
    const t = makeTournament({ variants_allowed: false });
    expect(rowEligible({ ...card, Variant: "Y" }, t)).toBe(false);
    expect(rowEligible({ ...card, Variant: "" }, t)).toBe(true);
  });

  const withRule = (over: object) => makeTournament({ eligibility: { mode: "ALL", rules: [{ id: "r", column: "Card Value", op: "num_ge", a: "80", ...over } as any] } });

  it("evaluates numeric operators", () => {
    expect(rowEligible(card, withRule({ op: "num_ge", a: "80" }))).toBe(true);
    expect(rowEligible({ ...card, "Card Value": "70" }, withRule({ op: "num_ge", a: "80" }))).toBe(false);
    expect(rowEligible(card, withRule({ op: "num_between", a: "60", b: "89" }))).toBe(true);
    expect(rowEligible({ ...card, "Card Value": "95" }, withRule({ op: "num_between", a: "60", b: "89" }))).toBe(false);
  });

  it("treats incomplete numeric rules as permissive (quirk)", () => {
    expect(rowEligible({ ...card, "Card Value": "10" }, withRule({ op: "num_ge", a: undefined }))).toBe(true);
  });

  it("evaluates set and text operators", () => {
    const setT = makeTournament({ eligibility: { mode: "ALL", rules: [{ id: "r", column: "Position", op: "set_in", values: ["7", "8", "9"] }] } });
    expect(rowEligible(card, setT)).toBe(true);
    expect(rowEligible({ ...card, Position: "2" }, setT)).toBe(false);
    const textT = makeTournament({ eligibility: { mode: "ALL", rules: [{ id: "r", column: "//Card Title", op: "text_contains", a: "Hardware" }] } });
    expect(rowEligible(card, textT)).toBe(true);
    expect(rowEligible({ ...card, "//Card Title": "PTCS 3 SP" }, textT)).toBe(false);
  });

  it("ANY mode passes if any rule passes", () => {
    const t = makeTournament({ eligibility: { mode: "ANY", rules: [
      { id: "a", column: "Card Value", op: "num_ge", a: "999" },
      { id: "b", column: "Position", op: "set_in", values: ["7"] },
    ] } });
    expect(rowEligible(card, t)).toBe(true);
  });
});

describe("buildEligiblePool", () => {
  it("filters by card-value range [60,89]", () => {
    const t = makeTournament({ card_value_min: 60, card_value_max: 89 });
    const pool = buildEligiblePool(catalog.cards, t);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.length).toBeLessThan(catalog.cards.length);
    for (const c of pool) {
      const v = Number(c["Card Value"]);
      expect(v).toBeGreaterThanOrEqual(60);
      expect(v).toBeLessThanOrEqual(89);
    }
  });

  it("ownedOnly excludes owned==0 (calibration pool ignores it by default)", () => {
    const t = makeTournament({ card_value_min: 60, card_value_max: 89 });
    const all = buildEligiblePool(catalog.cards, t);
    const owned = buildEligiblePool(catalog.cards, t, { ownedOnly: true });
    expect(owned.length).toBeLessThanOrEqual(all.length);
    for (const c of owned) expect(Number(c["owned"])).toBeGreaterThan(0);
  });
});

describe("tournament → eligible pool → calibrate", () => {
  it("calibrates over the eligibility-built pool and anchors to target", () => {
    const t = makeTournament({ card_value_min: 60, card_value_max: 89 });
    const pool = buildEligiblePool(catalog.cards, t);
    const scales = calibrate(pool, { coeffs: syntheticCoeffs, derived: computeDerived(syntheticCoeffs) });
    expect(pool.length).toBeGreaterThan(100);
    expect((scales.anchorMeanVR as number) * (scales.hitScaleVR as number)).toBeCloseTo(TARGET_WOBA, 9);
    expect((scales.anchorMeanPitch as number) * (scales.pitchScale as number)).toBeCloseTo(TARGET_WOBA, 9);
  });
});
