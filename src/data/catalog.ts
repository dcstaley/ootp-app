// M2a — the shared card catalog. Imports a pt_card_list.csv into typed rows.
// A Card is the raw column map (values are strings); the scoring core coerces
// numerics via its own `n()`. Account-specific ownership/variants are a later
// overlay (M2c, D6); the catalog itself is account-agnostic.

import Papa from "papaparse";

export type Card = Record<string, string>;

export interface Catalog {
  cards: Card[];
  columns: string[];
}

/** Parse a pt_card_list.csv (header row) into a catalog. */
export function parseCatalogCsv(text: string): Catalog {
  const parsed = Papa.parse<Card>(text, { header: true, skipEmptyLines: true });
  const cards = (parsed.data ?? []).filter((r) => r && typeof r === "object" && r["Card ID"] != null);
  // Drop papaparse's synthetic overflow key (the CSV's trailing comma yields one).
  for (const c of cards) delete (c as Record<string, unknown>)["__parsed_extra"];
  const columns = parsed.meta?.fields ?? (cards.length ? Object.keys(cards[0]!) : []);
  return { cards, columns };
}

/** Convenience: the card's id and human title. */
export const cardId = (c: Card): string => String(c["Card ID"] ?? "");
export const cardTitle = (c: Card): string => String(c["//Card Title"] ?? "");
