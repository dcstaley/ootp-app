// M2c — PT account overlays (D6). The card catalog (ratings/value/defense) is
// shared; what's account-specific is `owned` quantity and that account's
// variants. Two accounts are the immediate need but overlays are keyed so N is
// possible. PT-only (SP keeps its own single collection).

import Papa from "papaparse";
import type { Card, Catalog } from "./catalog.ts";
import { cardId } from "./catalog.ts";
import { makeVariant } from "./variants.ts";

export interface AccountOverlay {
  id: string;
  name: string;
  /** cardId -> quantity owned (from this account's pt_card_list.csv `owned` column). */
  owned: Record<string, number>;
  /** owned cards this account has created a (v5) variant of. */
  variantCardIds: string[];
}

/** Extract an account overlay from that account's imported CSV (its `owned` column). */
export function overlayFromCatalog(imported: Catalog, id: string, name: string): AccountOverlay {
  const owned: Record<string, number> = {};
  for (const c of imported.cards) {
    const q = Number(c["owned"]);
    if (Number.isFinite(q) && q > 0) owned[cardId(c)] = q;
  }
  return { id, name, owned, variantCardIds: [] };
}

/**
 * The working rows for an account: every shared catalog card with this account's
 * owned quantity stamped on, plus a v5 variant row for each card in
 * variantCardIds. Base + variant rows coexist (mutually exclusive at selection).
 */
export function buildAccountRows(catalog: Catalog, overlay: AccountOverlay): Card[] {
  const byId = new Map(catalog.cards.map((c) => [cardId(c), c]));
  const rows: Card[] = catalog.cards.map((c) => ({ ...c, owned: String(overlay.owned[cardId(c)] ?? 0) }));
  for (const id of overlay.variantCardIds) {
    const base = byId.get(id);
    if (base) rows.push({ ...makeVariant(base), owned: String(overlay.owned[id] ?? 0) });
  }
  return rows;
}

/**
 * Parse a game "variant export" CSV → the list of Card IDs the account has a
 * variant for. The game's export uses a `CID` column (mapping to the catalog's
 * `Card ID`); we ignore the in-game level/ratings entirely and recompute the v5
 * boost ourselves. Tolerant of column naming: prefers `CID`, then `Card ID`.
 * Returns the id column it used (null if none found) so callers can report it.
 */
export function parseVariantExport(text: string): { ids: string[]; column: string | null } {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const fields = parsed.meta?.fields ?? [];
  const column =
    fields.find((f) => /^cid$/i.test(f.trim())) ??
    fields.find((f) => /^card\s*id$/i.test(f.trim())) ??
    fields.find((f) => /\bcid\b|card\s*id/i.test(f)) ??
    null;
  if (!column) return { ids: [], column: null };
  const seen = new Set<string>();
  for (const row of parsed.data ?? []) {
    const v = String(row[column] ?? "").trim();
    if (v) seen.add(v);
  }
  return { ids: [...seen], column };
}

/** Owned filter (owned > 0) — the active-account ownership scope for generation. */
export const isOwned = (c: Card): boolean => (Number(c["owned"]) || 0) > 0;
export const ownedRows = (rows: Card[]): Card[] => rows.filter(isOwned);
