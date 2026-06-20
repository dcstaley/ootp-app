// M2c — v5 variant boost + account overlay (D6).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseCatalogCsv, cardId } from "../src/data/catalog.ts";
import { variantBoost, makeVariant, VARIANT_RATING_FIELDS, isVariant, variantKey } from "../src/data/variants.ts";
import { overlayFromCatalog, buildAccountRows, ownedRows, type AccountOverlay } from "../src/data/account.ts";

const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));

// The old L5 case of applyVariantBoost, replicated to assert parity.
const oldBoostL5 = (n: number) => n + Math.floor((5 * n + 40) / 80) + 2;

describe("variant boost (v5-only)", () => {
  it("matches the old applyVariantBoost(row, 5) per-field formula", () => {
    for (let n = 0; n <= 250; n++) expect(variantBoost(n)).toBe(oldBoostL5(n));
    expect(variantBoost(95)).toBe(103); // 95 + floor(515/80)=6 + 2
    expect(variantBoost(40)).toBe(45);  // 40 + floor(240/80)=3 + 2
  });

  it("makeVariant boosts only rating fields, flags Variant=Y, leaves others", () => {
    const base = { "Card ID": "1", "//Card Title": "X", "Eye vR": "100", "Card Value": "85", "Stamina": "60", "Variant": "" } as Record<string, string>;
    const v = makeVariant(base);
    expect(Number(v["Eye vR"])).toBe(variantBoost(100)); // boosted (in field list)
    expect(v["Card Value"]).toBe("85"); // not a rating field
    expect(v["Stamina"]).toBe("60");    // not in VARIANT_RATING_FIELDS
    expect(v["Card ID"]).toBe("1");     // shares id with base
    expect(isVariant(v)).toBe(true);
    expect(v["//Card Title"]).toContain("★");
    expect(VARIANT_RATING_FIELDS).toContain("Eye vR");
  });

  it("variantKey distinguishes a variant from its base", () => {
    const base = { "Card ID": "7", "Variant": "" } as Record<string, string>;
    expect(variantKey(base)).toBe("7");
    expect(variantKey(makeVariant(base))).toBe("7#V");
  });
});

describe("account overlay (D6)", () => {
  const overlay: AccountOverlay = { id: "A", name: "Acct A", owned: {}, variantCardIds: [] };
  const someId = cardId(catalog.cards[0]!);

  it("stamps owned quantity from the overlay onto shared catalog rows", () => {
    const o: AccountOverlay = { ...overlay, owned: { [someId]: 3 } };
    const rows = buildAccountRows(catalog, o);
    expect(rows.length).toBe(catalog.cards.length); // no variants yet
    const row = rows.find((r) => cardId(r) === someId)!;
    expect(row["owned"]).toBe("3");
    expect(ownedRows(rows).length).toBe(1); // only the one owned card
  });

  it("adds v5 variant rows for variantCardIds (sharing Card ID, boosted)", () => {
    const o: AccountOverlay = { ...overlay, owned: { [someId]: 2 }, variantCardIds: [someId] };
    const rows = buildAccountRows(catalog, o);
    expect(rows.length).toBe(catalog.cards.length + 1);
    const variant = rows.find((r) => cardId(r) === someId && isVariant(r))!;
    const base = catalog.cards[0]!;
    expect(variant).toBeTruthy();
    if (Number.isFinite(Number(base["Eye vR"]))) {
      expect(Number(variant["Eye vR"])).toBe(variantBoost(Number(base["Eye vR"])));
    }
    expect(variant["owned"]).toBe("2");
  });

  it("overlayFromCatalog extracts owned>0 quantities", () => {
    const o = overlayFromCatalog(catalog, "A", "Acct A");
    for (const [, q] of Object.entries(o.owned)) expect(q).toBeGreaterThan(0);
  });
});
