// WHICH CARDS CAN HAVE A VARIANT (Derek, 2026-07-22; Fable green light).
//
// Nothing in the codebase encoded this until now — `Card Type`, `Card Sub Type` and `Card Badge`
// were read nowhere in src/ or web/, so every construction of a hypothetical variant field silently
// fabricated a v5 for cards that cannot have one: 43.9% of the catalog, and 51.4% of the iron window.
//
// These pins guard the three things that can rot independently:
//   1. the RULES still select the classes they are supposed to, at the counts derived from evidence;
//   2. the rules stay DISJOINT, which is what lets `variantForbiddenClass` return a first match;
//   3. the OVERRIDE mechanism works — because the class rule is a default, never an authority.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseCatalogCsv, cardId, type Card } from "../src/data/catalog.ts";
import { canHaveVariant, variantForbiddenClass, VARIANT_OVERRIDES, VARIANT_FORBIDDEN_RULES } from "../src/data/variants.ts";

const cards = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

describe("variant eligibility", () => {
  it("selects each forbidden class at its evidenced count", () => {
    const n = (rule: string) => cards.filter((c) => variantForbiddenClass(c) === rule).length;
    // Counts from docs/CARD_VARIANT_ELIGIBILITY.md, each backed by 0 observed v5 across its played
    // members in the 2026-07-21 corpus. A catalog refresh legitimately moves these — when it does,
    // re-derive from the corpus and update here as part of the reviewed change, never by loosening.
    expect(n("Live")).toBe(1274);
    expect(n("LE")).toBe(90);
    expect(n("PTMS")).toBe(10);
    expect(n("Clubhouse")).toBe(144);
    expect(n("MissionEdition")).toBe(52);
    expect(n("PTCS")).toBe(36);
    expect(n("PTWC")).toBe(4);
  });

  it("the rules are mutually disjoint", () => {
    // `variantForbiddenClass` returns the FIRST match, which is only safe if no card matches two.
    const multi = cards.filter((c) => VARIANT_FORBIDDEN_RULES.filter((r) => variantForbiddenClass(c) === r).length > 1);
    expect(multi).toHaveLength(0);
  });

  it("forbids 43.9% of the catalog and over half the iron window", () => {
    const forbidden = cards.filter((c) => variantForbiddenClass(c) !== null);
    expect(forbidden.length).toBe(1610);
    const val = (c: Card) => Number(c["Card Value"] ?? NaN);
    const iron = cards.filter((c) => val(c) <= 59);
    const ironForbidden = iron.filter((c) => variantForbiddenClass(c) !== null);
    // Worst exactly where fabricated v5s were measured to reach the top-50 and move the gap.
    expect(ironForbidden.length / iron.length).toBeGreaterThan(0.50);
  });

  it("PTWC is title-keyed, and that fragility is deliberate and visible", () => {
    // The ONE rule that reads a display string rather than a field: PTWC carries no badge, no
    // distinguishing Card Type and no sub-type. If the title format ever changes these four cards
    // silently become variant-eligible, so the coupling is pinned rather than trusted.
    const ptwc = cards.filter((c) => variantForbiddenClass(c) === "PTWC");
    expect(ptwc).toHaveLength(4);
    for (const c of ptwc) {
      expect(String(c["//Card Title"])).toMatch(/^PTWC /);
      expect(String(c["Card Badge"] ?? "").trim(), "if PTWC ever gains a badge, key on it instead").toBe("");
    }
  });

  it("the dev-override list beats the class rule", () => {
    // Derek: the devs can grant a variant to a forbidden class. Tris Speaker is badge ME and has one.
    // The corpus cannot show this (VAL 100 sits outside all five Quick windows), which is exactly why
    // the list exists and why it is incomplete by construction.
    const tris = cards.find((c) => cardId(c) === "83846");
    expect(tris, "Tris Speaker (83846) missing from the catalog — re-derive the override list").toBeTruthy();
    expect(variantForbiddenClass(tris!)).toBe("MissionEdition");   // the class still forbids
    expect(canHaveVariant(tris!), "the override must win").toBe(true);
    expect(VARIANT_OVERRIDES.has("83846")).toBe(true);
  });

  it("an unforbidden card is eligible without needing an override", () => {
    const plain = cards.find((c) => variantForbiddenClass(c) === null && !VARIANT_OVERRIDES.has(cardId(c)))!;
    expect(canHaveVariant(plain)).toBe(true);
  });
});
