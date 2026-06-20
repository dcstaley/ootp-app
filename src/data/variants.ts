// M2c — variants (D6), v5-only (see decision: drop old levels 1-4 + the vlvl
// selector). A variant is the v5-boosted copy of a base card. Variant and base
// share a Card ID but the variant row carries Variant="Y"; they are mutually
// exclusive on a roster (enforced at selection, M4).

import type { Card } from "./catalog.ts";
import { cardId } from "./catalog.ts";

// Rating fields boosted by a variant (ported verbatim from old dataset.tsx
// VARIANT_RATING_FIELDS). Non-rating fields are copied unchanged.
export const VARIANT_RATING_FIELDS = [
  "BABIP vR", "BABIP vL", "Eye vR", "Eye vL", "Avoid K vR", "Avoid K vL",
  "Gap vR", "Gap vL", "Power vR", "Power vL",
  "BABIP", "Eye", "Gap", "Avoid Ks",
  "Stuff vR", "Stuff vL", "Control vR", "Control vL", "pBABIP vR", "pBABIP vL", "pHR vR", "pHR vL",
  "Speed", "Steal Rate", "Stealing", "Baserunning", "Hold",
  "DP", "Infield Range", "Infield Error", "Infield Arm", "CatcherAbil", "CatcherFrame", "Catcher Arm",
  "Pos Rating C", "Pos Rating 1B", "Pos Rating 2B", "Pos Rating 3B", "Pos Rating SS",
  "Pos Rating LF", "Pos Rating CF", "Pos Rating RF", "OF Range", "OF Error", "OF Arm",
] as const;

/** v5 boost — the old applyVariantBoost(row, 5) per-field formula. */
export function variantBoost(v: number): number {
  return v + Math.floor((5 * v + 40) / 80) + 2;
}

/** Produce a card's v5 variant row (boosted ratings, Variant="Y"). */
export function makeVariant(base: Card): Card {
  const out: Card = { ...base };
  for (const k of VARIANT_RATING_FIELDS) {
    const raw = base[k];
    const n = raw === "" || raw === undefined || raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) out[k] = String(variantBoost(n));
  }
  out["Variant"] = "Y";
  out["//Card Title"] = `★ ${base["//Card Title"] ?? ""}`;
  return out;
}

export const isVariant = (c: Card): boolean => String(c["Variant"] ?? "").trim().toUpperCase() === "Y";

/** Distinguishes a variant row from its base while sharing the Card ID. */
export const variantKey = (c: Card): string => `${cardId(c)}${isVariant(c) ? "#V" : ""}`;
